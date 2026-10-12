/**
 * ESM loader over ctx.sync.fs — static import/export, dynamic import(),
 * import.meta, and CJS interop.
 */
import { encodeFilePath } from '../builtins/url.mjs';
import { createPath } from '../path.mjs';
import { preserveSymlinks } from '../cjs/loader.mjs';
import { createResolver } from '../cjs/resolve.mjs';
import { nodeError } from '../node-errors.mjs';
import { shouldRunAsEsm, transformEsm } from './transform.mjs';

const decoder = new TextDecoder();
// `slicc` first, as for require (see cjs/resolve.mjs).
const IMPORT_CONDITIONS = ['slicc', 'import', 'node', 'default'];

function pathToFileURL(filename) {
  if (filename.startsWith('file:')) return filename;
  const p = filename.startsWith('/') ? filename : `/${filename}`;
  return `file://${encodeFilePath(p)}`;
}

function cjsToNamespace(exports) {
  if (exports && typeof exports === 'object' && exports.__esModule && 'default' in exports) {
    const ns = { ...exports };
    Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' });
    return ns;
  }
  const ns = { default: exports };
  // Functions (e.g. module.Module) are callable objects with named exports.
  if (
    exports != null &&
    (typeof exports === 'object' || typeof exports === 'function') &&
    !Array.isArray(exports)
  ) {
    for (const key of Reflect.ownKeys(exports)) {
      if (key === 'default') continue;
      try {
        const d = Object.getOwnPropertyDescriptor(exports, key);
        if (d) Object.defineProperty(ns, key, d);
      } catch {
        ns[key] = exports[key];
      }
    }
  }
  Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' });
  return ns;
}

function finalizeNamespace(exportsObj) {
  const ns = Object.create(null);
  for (const key of Reflect.ownKeys(exportsObj)) {
    Object.defineProperty(ns, key, Object.getOwnPropertyDescriptor(exportsObj, key));
  }
  Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' });
  return ns;
}

/** ERR_REQUIRE_ASYNC_MODULEs from inside a graph, renamed by requireEsm(). */
const deepAsync = new WeakSet();

/** Node 22.22's ERR_REQUIRE_ASYNC_MODULE (require() of an ES module graph with top-level await). */
function requireAsyncModule(filename, parentFilename) {
  let message =
    'require() cannot be used on an ESM graph with top-level await. Use import() instead. To see where the top-level await comes from, use --experimental-print-required-tla.';
  if (parentFilename) message += `\n  From ${parentFilename} `;
  if (filename) message += `\n  Requiring ${filename} `;
  return nodeError(Error, 'ERR_REQUIRE_ASYNC_MODULE', message);
}

export function createEsm({ ctx, process, handles, builtins, cjs, trackPromise } = {}) {
  const path = createPath(() => process.cwd());
  const fs = ctx.sync.fs;
  const packageCache = new Map();

  const readPackageJson = (pkgPath) => {
    if (packageCache.has(pkgPath)) return packageCache.get(pkgPath);
    try {
      const pkg = JSON.parse(decoder.decode(fs.readFile(pkgPath)));
      packageCache.set(pkgPath, pkg);
      return pkg;
    } catch {
      packageCache.set(pkgPath, null);
      return null;
    }
  };

  const resolver = createResolver({
    fs,
    path,
    readPackageJson,
    conditions: IMPORT_CONDITIONS,
    extensions: ['.js', '.mjs', '.cjs', '.json'],
    preserveSymlinks: preserveSymlinks(process),
    // node --expose-internals: import 'internal/…', as require() has it.
    exposeInternals: () => process.execArgv.includes('--expose-internals'),
  });

  /**
   * A builtin's namespace. Node 22 gives an internal module (exposed by
   * --expose-internals) only a default export, its module.exports.
   */
  function builtinNamespace(id) {
    const exports = builtins.load(id);
    if (!id.startsWith('internal/')) return cjsToNamespace(exports);
    const ns = Object.create(null);
    Object.defineProperty(ns, 'default', { value: exports, enumerable: true, writable: true });
    Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' });
    return ns;
  }

  /** @type {Map<string, { namespace?: object, exportsObj?: object, evaluating?: boolean, promise?: Promise<object> }>} */
  const cache = new Map();
  /** Filenames currently on the async evaluation stack (cycle detection). */
  const evaluatingStack = new Set();

  function findNearestPackage(fromDir) {
    let dir = fromDir;
    for (;;) {
      const pkgPath = path.join(dir, 'package.json');
      try {
        if (fs.exists(pkgPath)) return readPackageJson(pkgPath);
      } catch {
        /* continue */
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  function isEsmFilename(filename, source) {
    if (filename.endsWith('.mjs')) return true;
    if (filename.endsWith('.cjs') || filename.endsWith('.json')) return false;
    const pkg = findNearestPackage(path.dirname(filename));
    if (pkg?.type === 'module') return true;
    // Explicit CommonJS packages never use detect-module / ESM syntax fallback.
    if (pkg?.type === 'commonjs') return false;
    if (source != null && shouldRunAsEsm(source)) return true;
    return false;
  }

  // Static imports and import.meta.resolve fail as Node's ESM resolver does.
  function esmResolve(specifier, parentFilename) {
    try {
      return resolver.resolve(String(specifier), parentFilename, [parentFilename]);
    } catch (err) {
      if (err && err.code === 'MODULE_NOT_FOUND') err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    }
  }

  function makeImportMeta(filename) {
    // Node: ES module input from -e or stdin is `<cwd>/[eval1]` (a file URL,
    // with filename and dirname) — its import.meta and relative imports.
    const evalInput = filename.startsWith('[');
    if (evalInput) filename = `${process.cwd().replace(/\/$/, '')}/[eval1]`;
    // Node's URL for it keeps the brackets (pathToFileURL would encode them).
    const url = evalInput ? `${pathToFileURL(path.dirname(filename))}/[eval1]`.replace(':////', ':///') : pathToFileURL(filename);
    const meta = {
      url,
      resolve(specifier) {
        let resolved;
        try {
          resolved = esmResolve(specifier, filename);
        } catch (err) {
          // Node: a missing file (or a directory) still resolves to its URL;
          // only a package that can't be found throws.
          const spec = String(specifier);
          if (err?.code === 'ERR_MODULE_NOT_FOUND' && /^(\.{1,2}\/|\/|file:)/.test(spec)) {
            // URL resolution, as Node's: a query or fragment stays one.
            return new URL(spec, pathToFileURL(filename)).href;
          }
          throw err;
        }
        if (resolved.type === 'builtin') return `node:${resolved.id}`;
        return pathToFileURL(resolved.filename);
      },
    };
    // Node 22+: import.meta.dirname / import.meta.filename.
    meta.filename = filename;
    meta.dirname = path.dirname(filename);
    return meta;
  }

  function resolveAndLoadSync(specifier, parentFilename) {
    const resolved = esmResolve(specifier, parentFilename);
    if (resolved.type === 'builtin') {
      return builtinNamespace(resolved.id);
    }
    return loadFileSync(resolved.filename);
  }

  function evaluateEsm(filename, source) {
    const cached = cache.get(filename);
    if (cached?.namespace) return cached.namespace;
    if (cached?.evaluating) return cached.exportsObj;

    const { code, hasTopLevelAwait } = transformEsm(source, filename);
    if (hasTopLevelAwait) {
      const err = requireAsyncModule();
      deepAsync.add(err);
      throw err;
    }

    const exportsObj = Object.create(null);
    const entry = { evaluating: true, exportsObj };
    cache.set(filename, entry);

    const __meta = makeImportMeta(filename);
    const __importSync = (spec) => resolveAndLoadSync(spec, filename);
    const __import = (spec) => {
      // Dynamic import must support TLA modules (async evaluation).
      const p = importModule(String(spec), filename);
      if (trackPromise && handles) return trackPromise(handles, p);
      return p;
    };

    try {
      const fn = new Function(
        '__meta',
        '__importSync',
        '__import',
        '__exports',
        `"use strict";\n${code}`
      );
      fn(__meta, __importSync, __import, exportsObj);
    } catch (err) {
      cache.delete(filename);
      throw err;
    }

    const ns = finalizeNamespace(exportsObj);
    entry.namespace = ns;
    entry.evaluating = false;
    return ns;
  }

  async function evaluateEsmAsync(filename, source) {
    const cached = cache.get(filename);
    if (cached?.namespace) return cached.namespace;
    // Cycle: return the live exports object while linking (Node ESM semantics).
    if (cached?.evaluating && evaluatingStack.has(filename)) return cached.exportsObj;
    if (cached?.evaluating && cached.promise) return cached.promise;
    if (cached?.evaluating) return cached.exportsObj;

    const { bodyCode, staticSpecs, exportSetup, hoistImports } = transformEsm(
      source,
      filename
    );
    const exportsObj = Object.create(null);
    const entry = { evaluating: true, exportsObj };
    cache.set(filename, entry);
    evaluatingStack.add(filename);

    try {
      const __meta = makeImportMeta(filename);
      const __importSync = (spec) => resolveAndLoadSync(spec, filename);
      const __import = (spec) => {
        const p = importModule(String(spec), filename);
        if (trackPromise && handles) return trackPromise(handles, p);
        return p;
      };
      // After export bindings exist in this scope (and function decls are hoisted),
      // preload static deps so TLA graphs and cycles link under import().
      const __preload = async () => {
        for (const spec of staticSpecs) {
          const resolved = esmResolve(spec, filename);
          if (resolved.type === 'builtin') continue;
          const dep = cache.get(resolved.filename);
          if (dep?.namespace) continue;
          // Cycle partner already on our stack — link via live exportsObj later.
          if (dep?.evaluating && evaluatingStack.has(resolved.filename)) continue;
          // Shared in-flight TLA module from another import() graph — wait for it.
          if (dep?.promise) {
            await dep.promise;
            continue;
          }
          await importModule(spec, filename);
        }
      };

      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const parts = [
        ...exportSetup,
        'await __preload();',
        ...hoistImports,
        bodyCode,
        `//# sourceURL=${filename}`,
      ];
      const fn = new AsyncFunction(
        '__meta',
        '__importSync',
        '__import',
        '__exports',
        '__preload',
        `"use strict";\n${parts.join('\n')}`
      );
      await fn(__meta, __importSync, __import, exportsObj, __preload);
      const ns = finalizeNamespace(exportsObj);
      entry.namespace = ns;
      entry.evaluating = false;
      return ns;
    } finally {
      evaluatingStack.delete(filename);
    }
  }

  function loadFileSync(filename) {
    if (filename.endsWith('.json')) {
      const data = JSON.parse(decoder.decode(fs.readFile(filename)));
      return cjsToNamespace(data);
    }
    const cached = cache.get(filename);
    if (cached?.namespace) return cached.namespace;
    if (cached?.evaluating) return cached.exportsObj;

    const source = decoder.decode(fs.readFile(filename));
    if (!isEsmFilename(filename, source)) {
      const exports = cjs.loadFile(filename);
      const ns = cjsToNamespace(exports);
      cache.set(filename, { namespace: ns });
      return ns;
    }
    return evaluateEsm(filename, source);
  }

  async function loadFileAsync(filename) {
    if (filename.endsWith('.json')) {
      const data = JSON.parse(decoder.decode(fs.readFile(filename)));
      return cjsToNamespace(data);
    }
    const cached = cache.get(filename);
    if (cached?.namespace) return cached.namespace;
    if (cached?.evaluating && evaluatingStack.has(filename)) return cached.exportsObj;
    if (cached?.promise) return cached.promise;

    const source = decoder.decode(fs.readFile(filename));
    if (!isEsmFilename(filename, source)) {
      const exports = cjs.loadFile(filename);
      const ns = cjsToNamespace(exports);
      cache.set(filename, { namespace: ns });
      return ns;
    }
    // Always async-evaluate on the import() path so static deps with TLA link.
    return evaluateEsmAsync(filename, source);
  }

  async function importModule(specifier, parentFilename = `${process.cwd()}/`) {
    let resolved;
    try {
      resolved = resolver.resolve(String(specifier), parentFilename, [parentFilename]);
    } catch (err) {
      // Node ESM resolve failures use ERR_MODULE_NOT_FOUND; leave evaluation-time
      // MODULE_NOT_FOUND from nested CJS require() unchanged.
      if (err && err.code === 'MODULE_NOT_FOUND') err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    }
    if (resolved.type === 'builtin') {
      return builtinNamespace(resolved.id);
    }
    const filename = resolved.filename;
    const cached = cache.get(filename);
    if (cached?.namespace) return cached.namespace;
    if (cached?.promise) return cached.promise;
    // Cycle: live exports. Concurrent non-cycle evaluation: wait on promise below.
    if (cached?.evaluating && evaluatingStack.has(filename)) return cached.exportsObj;

    const promise = loadFileAsync(filename);
    // Re-read: loadFileAsync may have already set {evaluating, exportsObj} before
    // suspending; a stale pre-call snapshot would wipe those fields.
    cache.set(filename, { ...(cache.get(filename) || {}), promise });
    if (trackPromise && handles) trackPromise(handles, promise);
    const ns = await promise;
    cache.set(filename, { namespace: ns });
    return ns;
  }

  function runMain(filename, source) {
    const src = source ?? decoder.decode(fs.readFile(filename));
    if (!isEsmFilename(filename, src)) {
      return cjs.runMain(filename, src);
    }
    const { hasTopLevelAwait } = transformEsm(src, filename);
    // The entry's top-level await is not a handle: as in Node, a pending
    // await does not keep the program alive (run.mjs reports it, exit 13).
    if (hasTopLevelAwait) return evaluateEsmAsync(filename, src);
    return evaluateEsm(filename, src);
  }

  function runEsmEval(code, filename = '[eval]') {
    // Always treat as ESM (covers dynamic import() without static import/export).
    const { hasTopLevelAwait } = transformEsm(code, filename);
    if (hasTopLevelAwait) return evaluateEsmAsync(filename, code);
    return evaluateEsm(filename, code);
  }

  /**
   * Force-evaluate as ESM (CJS `require()` of ESM, or CJS wrapper-name
   * redeclare retry). Must not fall back to cjs.loadFile — the module may
   * already be in the CJS cache mid-compile.
   */
  function requireEsm(filename, parentFilename) {
    const cached = cache.get(filename);
    if (cached?.namespace) return cached.namespace;
    if (cached?.evaluating) return cached.exportsObj;
    const source = decoder.decode(fs.readFile(filename));
    const { hasTopLevelAwait } = transformEsm(source, filename);
    // Node names the required module and its requirer, wherever in the
    // graph the top-level await is.
    if (hasTopLevelAwait) throw requireAsyncModule(filename, parentFilename);
    try {
      return evaluateEsm(filename, source);
    } catch (err) {
      if (deepAsync.has(err)) throw requireAsyncModule(filename, parentFilename);
      throw err;
    }
  }

  return {
    importModule,
    runMain,
    runEsmEval,
    requireEsm,
    isEsmFilename,
    loadFileSync,
    resolver,
  };
}
