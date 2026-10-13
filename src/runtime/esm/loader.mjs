/**
 * ESM loader over ctx.sync.fs — static import/export, dynamic import(),
 * import.meta, and CJS interop.
 */
import { encodeFilePath } from '../builtins/url.mjs';
import { createPath } from '../path.mjs';
import { preserveSymlinks } from '../cjs/loader.mjs';
import { createResolver } from '../cjs/resolve.mjs';
import { nodeError } from '../node-errors.mjs';
import { registerEsmFrames } from '../stack.mjs';
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

/** Namespaces of CommonJS modules (for the missing-named-export message). */
const cjsNamespaces = new WeakSet();

/**
 * A static import of a name the module doesn't export: Node's SyntaxError,
 * worded for a CommonJS module or for any other.
 */
function missingExport(ns, spec, name) {
  if (cjsNamespaces.has(ns)) {
    throw new SyntaxError(
      `Named export '${name}' not found. The requested module '${spec}' is a CommonJS module, which may not support all module.exports as named exports.\nCommonJS modules can always be imported via the default export, for example using:\n\nimport pkg from '${spec}';\nconst { ${name} } = pkg;\n`
    );
  }
  throw new SyntaxError(`The requested module '${spec}' does not provide an export named '${name}'`);
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
    esm: true,
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

  /**
   * A module's id: its path, plus its URL's query and fragment when it has
   * them (`./x.mjs?a` and `./x.mjs?b` are two modules, as in Node). The cache
   * is keyed by id; reading and resolving use the path.
   */
  const idParts = new Map();
  function idOf(filename, suffix) {
    if (!suffix) return filename;
    const id = `${filename}\u0000${suffix}`;
    idParts.set(id, { path: filename, suffix });
    return id;
  }
  const pathOf = (id) => idParts.get(id)?.path ?? id;
  const suffixOf = (id) => idParts.get(id)?.suffix ?? '';

  /**
   * Node's import attributes (validateAttributes): a JSON module needs
   * `type: 'json'`, a JavaScript one mustn't have it, and `type` takes no
   * other value.
   */
  function checkAttributes(url, isJson, attributes) {
    const type = attributes?.type;
    if (type !== undefined && type !== 'json') {
      throw nodeError(TypeError, 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', `Import attribute "type" with value "${type}" is not supported in ${url}`);
    }
    if (isJson && type !== 'json') {
      throw nodeError(TypeError, 'ERR_IMPORT_ATTRIBUTE_MISSING', `Module "${url}" needs an import attribute of "type: json"`);
    }
    if (!isJson && type === 'json') {
      throw nodeError(TypeError, 'ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE', `Module "${url}" is not of type "json"`);
    }
  }
  const urlOfResolved = (r) =>
    r.type === 'data' ? r.url : r.type === 'builtin' ? `node:${r.id}` : pathToFileURL(pathOf(r.filename)) + suffixOf(r.filename);
  const isJsonResolved = (r) =>
    r.type === 'data'
      ? /^data:application\/json[;,]/i.test(r.url)
      : r.type === 'file' && pathOf(r.filename).endsWith('.json');

  /** import()'s second argument, as V8 checks it; its `with` attributes. */
  function attributesOf(options) {
    if (options === undefined) return undefined;
    if (options === null || typeof options !== 'object') {
      throw new TypeError('The second argument to import() must be an object');
    }
    const attrs = options.with ?? options.assert;
    if (attrs === undefined) return undefined;
    if (attrs === null || typeof attrs !== 'object') throw new TypeError("The 'assert' option must be an object");
    return attrs;
  }

  // Static imports and import.meta.resolve fail as Node's ESM resolver does.
  /** What Node names the importing module in its errors. */
  const parentLabel = (parentFilename) => {
    // --import's: the working directory itself (Node's parent URL is it).
    if (parentFilename?.endsWith('/[import]')) return parentFilename.slice(0, -8);
    return !parentFilename || parentFilename.startsWith('[') || parentFilename.endsWith('/')
      ? `${process.cwd().replace(/\/$/, '')}/[eval1]`
      : parentFilename;
  };

  /**
   * Node's ESM resolve: URL specifiers (node:, file:, data:; any other scheme
   * is ERR_UNSUPPORTED_ESM_URL_SCHEME), relative ones resolved as URLs
   * against the importer (%-escapes decoded, query and fragment dropped),
   * exact files only, and Node's ERR_MODULE_NOT_FOUND /
   * ERR_UNSUPPORTED_DIR_IMPORT messages.
   */
  function esmResolve(specifier, parentFilename) {
    let spec = String(specifier);
    const scheme = /^([a-zA-Z][a-zA-Z\d+.-]*):/.exec(spec)?.[1]?.toLowerCase();
    if (scheme === 'data') return { type: 'data', url: spec };
    if (scheme && scheme !== 'node' && scheme !== 'file') {
      const schemes = scheme === 'http' || scheme === 'https' ? 'file and data' : 'file, data, and node';
      const err = nodeError(
        Error,
        'ERR_UNSUPPORTED_ESM_URL_SCHEME',
        `Only URLs with a scheme in: ${schemes} are supported by the default ESM loader. Received protocol '${scheme}:'`
      );
      throw err;
    }
    let suffix = '';
    if (scheme === 'file' || spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../')) {
      // A data: module is no base for a relative URL (Node).
      if (scheme !== 'file' && parentFilename?.startsWith('data:')) {
        throw nodeError(
          TypeError,
          'ERR_UNSUPPORTED_RESOLVE_REQUEST',
          `Failed to resolve module specifier "${spec}" from "${parentFilename}": Invalid relative URL or base scheme is not hierarchical.`
        );
      }
      let url;
      try {
        const base = parentFilename && !parentFilename.startsWith('[') ? pathOf(parentFilename) : `${process.cwd().replace(/\/$/, '')}/`;
        url = new URL(spec, `file://${encodeFilePath(base)}`);
      } catch {
        url = undefined;
      }
      if (url) {
        if (url.hostname !== '') {
          throw nodeError(TypeError, 'ERR_INVALID_FILE_URL_HOST', 'File URL host must be "localhost" or empty on linux');
        }
        if (/%2f|%5c/i.test(url.pathname)) {
          throw nodeError(
            TypeError,
            'ERR_INVALID_MODULE_SPECIFIER',
            `Invalid module "${url.pathname}" must not include encoded "/" or "\\" characters imported from ${parentLabel(parentFilename)}`
          );
        }
        spec = decodeURIComponent(url.pathname);
        // The query and fragment are part of the module's identity (Node).
        suffix = url.search + url.hash;
      }
    }
    try {
      const resolved = resolver.resolve(spec, parentFilename && pathOf(parentFilename), [parentFilename]);
      if (suffix && resolved.type === 'file') resolved.filename = idOf(resolved.filename, suffix);
      return resolved;
    } catch (err) {
      const why = err?.esmResolveError;
      const from = parentLabel(parentFilename);
      if (why) {
        let e;
        if (why.kind === 'package') {
          e = nodeError(Error, 'ERR_MODULE_NOT_FOUND', `Cannot find package '${why.value}' imported from ${from}`);
        } else {
          const where = why.kind === 'dir' && spec.endsWith('/') ? `${why.value}/` : why.value;
          e =
            why.kind === 'dir'
              ? nodeError(
                  Error,
                  'ERR_UNSUPPORTED_DIR_IMPORT',
                  `Directory import '${where}' is not supported resolving ES modules imported from ${from}`
                )
              : nodeError(Error, 'ERR_MODULE_NOT_FOUND', `Cannot find module '${where}' imported from ${from}`);
          e.url = pathToFileURL(where);
        }
        commonJsHint(e, spec, parentFilename);
        throw e;
      }
      if (err?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        throw nodeError(Error, 'ERR_PACKAGE_PATH_NOT_EXPORTED', `${err.message} imported from ${from}`);
      }
      if (err && err.code === 'MODULE_NOT_FOUND') err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    }
  }

  /**
   * Node's decorateErrorWithCommonJSHints: when require() would have found
   * the module, say so ("Did you mean to import "pkg/sub.js"?").
   */
  function commonJsHint(err, specifier, parentFilename) {
    if (!parentFilename || parentFilename.startsWith('[') || parentFilename.startsWith('data:')) return;
    let found;
    try {
      found = cjs.makeRequire(parentFilename).resolve(specifier);
    } catch {
      return;
    }
    if (typeof found !== 'string' || !found.startsWith('/')) return;
    if (/^\.{1,2}\//.test(specifier)) {
      found = path.relative(path.dirname(parentFilename), found);
      if (!found.startsWith('../')) found = `./${found}`;
    } else if (!specifier.startsWith('/')) {
      const i = specifier.indexOf('/');
      const pkg = i === -1 ? specifier : specifier.slice(0, i);
      const needle = `/node_modules/${pkg}/`;
      const index = found.lastIndexOf(needle);
      found =
        index !== -1
          ? `${pkg}/${found.slice(index + needle.length).split('/').map(encodeURIComponent).join('/')}`
          : pathToFileURL(found);
    }
    if (found === specifier) return;
    const hint = `Did you mean to import ${JSON.stringify(found)}?`;
    const nl = err.stack.indexOf('\n');
    err.stack = nl === -1 ? `${err.stack}\n${hint}` : `${err.stack.slice(0, nl)}\n${hint}${err.stack.slice(nl)}`;
    err.message += `\n${hint}`;
  }

  /** A data: URL module (text/javascript or application/json), as Node loads it. */
  const dataModules = new Map();
  function loadDataModule(url) {
    if (dataModules.has(url)) return dataModules.get(url);
    const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(url);
    const mime = (m?.[1] ?? '').split(';')[0].trim().toLowerCase();
    let source = '';
    if (m) {
      source = m[2] ? decoder.decode(Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0))) : decodeURIComponent(m[3]);
    }
    let ns;
    if (!m) throw nodeError(TypeError, 'ERR_INVALID_URL', 'Invalid URL');
    if (mime === 'application/json') {
      ns = Object.create(null);
      Object.defineProperty(ns, 'default', { value: JSON.parse(source), enumerable: true, writable: true });
      Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' });
    } else if (mime === 'text/javascript' || mime === 'application/javascript') {
      ns = undefined;
    } else {
      throw nodeError(TypeError, 'ERR_UNKNOWN_MODULE_FORMAT', `Unknown module format: ${mime || 'data'} for URL ${url}`);
    }
    const out = { source, ns };
    dataModules.set(url, out);
    return out;
  }

  function makeImportMeta(filename) {
    // Node: ES module input from -e or stdin is `<cwd>/[eval1]` (a file URL,
    // with filename and dirname) — its import.meta and relative imports.
    if (filename.startsWith('data:')) {
      // Node: a data: module's import.meta has only its url (and resolve).
      return {
        url: filename,
        resolve: (specifier) => {
          const r = esmResolve(specifier, filename);
          return r.type === 'builtin' ? `node:${r.id}` : r.type === 'data' ? r.url : pathToFileURL(r.filename);
        },
      };
    }
    const suffix = suffixOf(filename);
    filename = pathOf(filename);
    const evalInput = filename.startsWith('[') || filename.endsWith('/[eval1]');
    if (evalInput) filename = `${process.cwd().replace(/\/$/, '')}/[eval1]`;
    // Node's URL for it keeps the brackets (pathToFileURL would encode them).
    const url = evalInput
      ? `${pathToFileURL(path.dirname(filename))}/[eval1]`.replace(':////', ':///')
      : pathToFileURL(filename) + suffix;
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
          if (
            (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'ERR_UNSUPPORTED_DIR_IMPORT') &&
            /^(\.{1,2}\/|\/|file:)/.test(spec)
          ) {
            // URL resolution, as Node's: a query or fragment stays one.
            return new URL(spec, pathToFileURL(filename)).href;
          }
          throw err;
        }
        return urlOfResolved(resolved);
      },
    };
    // Node 22+: import.meta.dirname / import.meta.filename.
    meta.filename = filename;
    meta.dirname = path.dirname(filename);
    return meta;
  }

  function resolveAndLoadSync(specifier, parentFilename, attributes) {
    const resolved = esmResolve(specifier, parentFilename);
    if (resolved.type !== 'builtin') checkAttributes(urlOfResolved(resolved), isJsonResolved(resolved), attributes);
    if (resolved.type === 'data') {
      const { source, ns } = loadDataModule(resolved.url);
      return ns ?? evaluateEsm(resolved.url, source);
    }
    if (resolved.type === 'builtin') {
      return builtinNamespace(resolved.id);
    }
    return loadFileSync(resolved.filename);
  }

  function evaluateEsm(filename, source) {
    const cached = cache.get(filename);
    if (cached?.namespace) return cached.namespace;
    if (cached?.evaluating) return cached.exportsObj;

    const { code, hasTopLevelAwait, preambleLines, columnShifts } = transformEsm(source, pathOf(filename));
    if (hasTopLevelAwait) {
      const err = requireAsyncModule();
      deepAsync.add(err);
      throw err;
    }

    const exportsObj = Object.create(null);
    const entry = { evaluating: true, exportsObj };
    cache.set(filename, entry);

    const __meta = makeImportMeta(filename);
    const __importSync = (spec, attributes) => resolveAndLoadSync(spec, filename, attributes);
    __importSync.missing = missingExport;
    const __import = (spec, options) => {
      // A module still evaluating: its own promise, which doesn't keep the program alive.
      const pending = evaluatingDone(spec, filename);
      if (pending) return pending;
      // Dynamic import must support TLA modules (async evaluation).
      const p = Promise.resolve().then(() => importModule(String(spec), filename, attributesOf(options), true));
      if (trackPromise && handles) return trackPromise(handles, p);
      return p;
    };

    // Its frames: the file's own lines, as a file: URL (see stack.mjs).
    registerEsmFrames(pathOf(filename), 1 + preambleLines, columnShifts);
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

    const { bodyCode, staticSpecs, staticAttributes, exportSetup, hoistImports, columnShifts } = transformEsm(
      source,
      pathOf(filename)
    );
    const exportsObj = Object.create(null);
    const entry = { evaluating: true, exportsObj };
    let settle;
    entry.done = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    entry.done.catch(() => {});
    cache.set(filename, entry);
    evaluatingStack.add(filename);

    try {
      const __meta = makeImportMeta(filename);
      const __importSync = (spec, attributes) => resolveAndLoadSync(spec, filename, attributes);
      __importSync.missing = missingExport;
      const __import = (spec, options) => {
        // A module still evaluating: its own promise, which doesn't keep the program alive.
        const pending = evaluatingDone(spec, filename);
        if (pending) return pending;
        const p = Promise.resolve().then(() => importModule(String(spec), filename, attributesOf(options), true));
        if (trackPromise && handles) return trackPromise(handles, p);
        return p;
      };
      // After export bindings exist in this scope (and function decls are hoisted),
      // preload static deps so TLA graphs and cycles link under import().
      const __preload = async () => {
        for (const spec of staticSpecs) {
          const resolved = esmResolve(spec, filename);
          if (resolved.type === 'builtin' || resolved.type === 'data') continue;
          const dep = cache.get(resolved.filename);
          if (dep?.namespace) continue;
          // Cycle partner already on our stack — link via live exportsObj later.
          if (dep?.evaluating && evaluatingStack.has(resolved.filename)) continue;
          // Shared in-flight TLA module from another import() graph — wait for it.
          if (dep?.promise) {
            await dep.promise;
            continue;
          }
          await importModule(spec, filename, staticAttributes?.[spec]);
        }
      };

      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const prefix = [...exportSetup, 'await __preload();', ...hoistImports].join('\n');
      const parts = [prefix, bodyCode, `//# sourceURL=${pathOf(filename)}`];
      registerEsmFrames(pathOf(filename), 1 + (prefix.match(/\n/g) || []).length + 1, columnShifts);
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
      settle.resolve(ns);
      return ns;
    } catch (err) {
      settle.reject(err);
      throw err;
    } finally {
      evaluatingStack.delete(filename);
    }
  }

  function loadFileSync(filename) {
    const file = pathOf(filename);
    if (file.endsWith('.json')) return jsonNamespace(filename);
    const cached = cache.get(filename);
    if (cached?.namespace) return cached.namespace;
    if (cached?.evaluating) return cached.exportsObj;

    const source = decoder.decode(fs.readFile(file));
    if (!isEsmFilename(file, source)) {
      const exports = cjs.loadFile(file);
      const ns = cjsFileNamespace(file, source, exports);
      cache.set(filename, { namespace: ns });
      return ns;
    }
    return evaluateEsm(filename, source);
  }

  /**
   * The names a CommonJS module has when imported (Node's
   * cjsPreparseModuleExports): what cjs-module-lexer finds in its source,
   * plus, for each `module.exports = require('…')`-style re-export, that
   * module's names (resolved as require() would, .js files only).
   */
  const cjsNames = new Map();
  function cjsExportNames(file, source) {
    if (cjsNames.has(file)) return cjsNames.get(file);
    // Cached (and filled in place) before the re-exports are followed, as in
    // Node: a re-export cycle gives each module what the other has so far.
    const names = new Set();
    cjsNames.set(file, names);
    let parsed;
    try {
      parsed = process._nodeLib().cjsLexer.parse(source ?? decoder.decode(fs.readFile(file)));
    } catch {
      parsed = { exports: [], reexports: [] };
    }
    for (const n of parsed.exports) names.add(n);
    for (const spec of parsed.reexports) {
      try {
        const target = cjs.makeRequire(file).resolve(spec);
        if (typeof target !== 'string' || !target.startsWith('/')) continue;
        if (!(target.endsWith('.js') || target.endsWith('.cjs')) || isEsmFilename(target)) continue;
        for (const n of cjsExportNames(target)) names.add(n);
      } catch {
        /* unresolvable: no names from it */
      }
    }
    return names;
  }

  /** Node's namespace of an imported CommonJS module (after it ran): default is module.exports, plus the lexer's names. */
  function cjsFileNamespace(file, source, exports) {
    const ns = Object.create(null);
    const names = [...cjsExportNames(file, source)].filter((n) => n !== 'default').sort();
    const isObj = exports !== null && (typeof exports === 'object' || typeof exports === 'function');
    // The named exports are their values now (Node takes them once, after
    // the module ran); only default, module.exports itself, stays live.
    for (const name of ['default', ...names].sort()) {
      let value = exports;
      if (name !== 'default') {
        try {
          value = isObj ? exports[name] : undefined;
        } catch {
          value = undefined;
        }
      }
      Object.defineProperty(ns, name, { enumerable: true, get: () => value });
    }
    Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' });
    cjsNamespaces.add(ns);
    return Object.preventExtensions(ns);
  }

  /** A JSON module: its default export is the parsed file, once per id. */
  function jsonNamespace(filename) {
    const cached = cache.get(filename);
    if (cached?.namespace) return cached.namespace;
    const ns = Object.create(null);
    Object.defineProperty(ns, 'default', {
      value: JSON.parse(decoder.decode(fs.readFile(pathOf(filename)))),
      enumerable: true,
      writable: true,
    });
    Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' });
    cache.set(filename, { namespace: ns });
    return ns;
  }

  async function loadFileAsync(filename) {
    const file = pathOf(filename);
    if (file.endsWith('.json')) return jsonNamespace(filename);
    const cached = cache.get(filename);
    if (cached?.namespace) return cached.namespace;
    if (cached?.evaluating && evaluatingStack.has(filename)) return cached.exportsObj;
    if (cached?.promise) return cached.promise;

    const source = decoder.decode(fs.readFile(file));
    if (!isEsmFilename(file, source)) {
      const exports = cjs.loadFile(file);
      const ns = cjsFileNamespace(file, source, exports);
      cache.set(filename, { namespace: ns });
      return ns;
    }
    // Always async-evaluate on the import() path so static deps with TLA link.
    return evaluateEsmAsync(filename, source);
  }

  async function importModule(specifier, parentFilename = `${process.cwd()}/`, attributes, dynamic = false) {
    const resolved = esmResolve(specifier, parentFilename);
    if (resolved.type !== 'builtin') checkAttributes(urlOfResolved(resolved), isJsonResolved(resolved), attributes);
    if (resolved.type === 'data') {
      const { source, ns } = loadDataModule(resolved.url);
      return ns ?? evaluateEsmAsync(resolved.url, source);
    }
    if (resolved.type === 'builtin') {
      return builtinNamespace(resolved.id);
    }
    const filename = resolved.filename;
    const cached = cache.get(filename);
    if (cached?.namespace) return cached.namespace;
    if (cached?.promise) return cached.promise;
    // A dynamic import() of a module still evaluating waits for it, as in Node
    // (a module that imports itself under top-level await never settles).
    if (dynamic && cached?.evaluating && cached.done) return cached.done;
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

  /** The evaluation promise of the module `spec` names, if it is still evaluating. */
  function evaluatingDone(spec, parentFilename) {
    try {
      const r = esmResolve(String(spec), parentFilename);
      if (r.type !== 'file') return undefined;
      const c = cache.get(r.filename);
      return c?.evaluating && !c.namespace && c.done ? c.done : undefined;
    } catch {
      return undefined;
    }
  }

  /** import(specifier, options) from outside a module (CommonJS, .jsh, new Function). */
  function importDynamic(specifier, parentFilename, options) {
    return Promise.resolve().then(() => importModule(String(specifier), parentFilename, attributesOf(options), true));
  }

  /**
   * node --import X: X's evaluation as an entry's (not a handle: a pending
   * top-level await of its own doesn't keep the program alive), from the
   * working directory.
   */
  async function importPreload(specifier) {
    const parent = `${process.cwd().replace(/\/$/, '')}/[import]`;
    const resolved = esmResolve(String(specifier), parent);
    if (resolved.type === 'file') {
      const filename = resolved.filename;
      const cached = cache.get(filename);
      if (cached?.namespace) return cached.namespace;
      const src = decoder.decode(fs.readFile(pathOf(filename)));
      if (isEsmFilename(pathOf(filename), src) && transformEsm(src, pathOf(filename)).hasTopLevelAwait) {
        const ns = await evaluateEsmAsync(filename, src);
        cache.set(filename, { namespace: ns });
        return ns;
      }
    }
    return importModule(String(specifier), parent);
  }

  return {
    importModule,
    importDynamic,
    importPreload,
    runMain,
    runEsmEval,
    requireEsm,
    isEsmFilename,
    loadFileSync,
    resolver,
  };
}
