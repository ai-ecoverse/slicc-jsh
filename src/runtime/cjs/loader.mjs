import { rewriteDynamicImports } from '../esm/transform.mjs';
import { syntaxReport } from '../syntax-report.mjs';
import { createPath } from '../path.mjs';
import { createBuiltins } from './builtins.mjs';
import { createResolver, isBuiltinName } from './resolve.mjs';

const decoder = new TextDecoder();

/**
 * Synchronous CJS module system over ctx.sync.
 */
/** Node's Module._nodeModulePaths: node_modules from `dir` up to the root. */
function nodeModulePaths(dir) {
  const parts = dir.split('/').filter(Boolean);
  const out = [];
  for (let i = parts.length; i >= 0; i--) {
    if (parts[i - 1] === 'node_modules') continue;
    out.push(`/${[...parts.slice(0, i), 'node_modules'].join('/')}`);
  }
  return out;
}

/** Node: `--preserve-symlinks` or NODE_PRESERVE_SYMLINKS=1 keeps link paths. */
export function preserveSymlinks(process) {
  return (
    (process?.execArgv ?? []).includes('--preserve-symlinks') ||
    process?.env?.NODE_PRESERVE_SYMLINKS === '1'
  );
}

export function createCjs({
  ctx,
  process,
  Buffer,
  console,
  timers,
  handles,
  fetch: fetchBinding,
  WebSocket: webSocketBinding,
} = {}) {
  const path = createPath(() => process.cwd());
  const fs = ctx.sync.fs;
  const packageCache = new Map();

  const readPackageJson = (pkgPath) => {
    if (packageCache.has(pkgPath)) return packageCache.get(pkgPath);
    try {
      const text = decoder.decode(fs.readFile(pkgPath));
      const pkg = JSON.parse(text);
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
    preserveSymlinks: preserveSymlinks(process),
    exposeInternals: () => process.execArgv.includes('--expose-internals'),
  });
  const builtins = createBuiltins({ ctx, process, Buffer, console, path, handles, timers });
  // Node lib files the runtime runs (src/node-lib) require fs, path, console.
  process._builtinLoader = (id) => builtins.load(id);
  const cache = Object.create(null);

  function Module(id, parent) {
    this.id = id;
    this.filename = id;
    this.path = path.dirname(id);
    this.exports = {};
    this.parent = parent ?? null;
    this.loaded = false;
    this.children = [];
    this.paths = id.startsWith('/') ? nodeModulePaths(path.dirname(id)) : [];
  }
  Module._cache = cache;
  // Node resolves a relative `from` against the working directory.
  Module._nodeModulePaths = (from) => nodeModulePaths(path.resolve(process.cwd(), String(from)));
  Module.builtinModules = [
    'assert',
    'assert/strict',
    'buffer',
    'console',
    'events',
    'fs',
    'fs/promises',
    'http',
    'https',
    'module',
    'net',
    'os',
    'path',
    'path/posix',
    'process',
    'querystring',
    'stream',
    'stream/promises',
    'string_decoder',
    'timers',
    'timers/promises',
    'url',
    'util',
    'util/types',
  ];
  // Node's: $HOME/.node_modules, $HOME/.node_libraries, <prefix>/lib/node.
  const home = process.env.HOME;
  Module.globalPaths = [
    ...(home ? [path.resolve(home, '.node_modules'), path.resolve(home, '.node_libraries')] : []),
    path.resolve(process.execPath, '..', '..', 'lib', 'node'),
  ];
  /** Node's Module._resolveLookupPaths: where a request is looked up from `parent`. */
  Module._resolveLookupPaths = (request, parent) => {
    if (Module.isBuiltin(request)) return null;
    const r = String(request);
    if (r[0] !== '.' || (r.length > 1 && r[1] !== '.' && r[1] !== '/')) {
      const paths = parent?.paths?.length ? [...parent.paths, ...Module.globalPaths] : Module.globalPaths;
      return paths.length > 0 ? paths : null;
    }
    // In the REPL, parent.filename is null.
    if (!parent || !parent.id || !parent.filename) return ['.'];
    return [path.dirname(parent.filename)];
  };
  Module.isBuiltin = (id) => {
    if (typeof id !== 'string') return false;
    const bare = id.startsWith('node:') ? id.slice(5) : id;
    return isBuiltinName(bare);
  };
  Module.createRequire = (filename) => {
    let parent;
    if (typeof filename === 'string') {
      // Node accepts file URL strings (import.meta.url), not only URL objects.
      if (filename.startsWith('file:')) {
        try {
          // Decode percent-escapes (spaces, Unicode, etc.) like fileURLToPath.
          parent = decodeURIComponent(new URL(filename).pathname);
        } catch {
          parent = filename;
        }
      } else {
        parent = filename;
      }
    } else if (filename?.href) {
      try {
        parent = decodeURIComponent(filename.pathname);
      } catch {
        parent = filename.pathname;
      }
    } else {
      parent = `${process.cwd()}/`;
    }
    return makeRequire(parent);
  };
  Module.prototype.require = function require(id) {
    return makeRequire(this.filename)(id);
  };

  /**
   * Node's Module._compile shape: wrapper is
   * `(function (exports, require, module, __filename, __dirname) { … })`.
   * process/Buffer/console/timers are real globals (installed on globalThis).
   */
  Module.prototype._compile = function _compile(wrapper, filename) {
    const dirname = path.dirname(filename);
    const require = makeRequire(filename, this);
    wrapper.call(this.exports, this.exports, require, this, filename, dirname);
  };

  Module._extensions = {
    '.js'(module, filename) {
      const source = decoder.decode(fs.readFile(filename));
      compile(module, source, filename);
    },
    '.cjs'(module, filename) {
      Module._extensions['.js'](module, filename);
    },
    '.json'(module, filename) {
      module.exports = JSON.parse(decoder.decode(fs.readFile(filename)));
    },
  };

  // Node: require('module') === Module constructor; Module.Module === Module.
  Module.Module = Module;
  builtins.installModule(Module);

  function findPackageType(fromDir) {
    let dir = fromDir;
    for (;;) {
      const pkgPath = path.join(dir, 'package.json');
      try {
        if (fs.exists(pkgPath)) {
          const pkg = readPackageJson(pkgPath);
          if (pkg) return pkg;
        }
      } catch {
        /* continue */
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  function stripHashbang(source) {
    if (source.startsWith('#!')) {
      const nl = source.indexOf('\n');
      return nl === -1 ? '' : source.slice(nl + 1);
    }
    return source;
  }

  /**
   * What require(esm) returns (Node's loadESMFromCJS): its 'module.exports'
   * export if it has one; else the namespace, unless it has a default export
   * and no __esModule of its own — then a facade with the same live exports
   * and __esModule: true, so transpiled code takes .default.
   */
  function requiredEsmExports(namespace) {
    if (namespace == null || typeof namespace !== 'object') return namespace;
    const has = (k) => Object.prototype.hasOwnProperty.call(namespace, k);
    if (has('module.exports')) return namespace['module.exports'];
    if (!has('default') || has('__esModule')) return namespace;
    const facade = Object.create(null);
    for (const key of [...Object.keys(namespace), '__esModule'].sort()) {
      Object.defineProperty(
        facade,
        key,
        key === '__esModule'
          ? { value: true, enumerable: true, writable: true, configurable: false }
          : { get: () => namespace[key], enumerable: true, configurable: false }
      );
    }
    Object.defineProperty(facade, Symbol.toStringTag, { value: 'Module' });
    return Object.preventExtensions(facade);
  }

  /** Set by run.mjs once the ESM loader exists — sync require() of ESM. */
  let requireEsmHook = null;
  function setRequireEsmHook(fn) {
    requireEsmHook = fn;
  }
  /** Dynamic import() from CJS — parent is the requiring file's path. */
  let importModuleHook = null;
  function setImportModuleHook(fn) {
    importModuleHook = fn;
  }

  function compile(mod, source, filename) {
    const dirname = path.dirname(filename);
    const wantsEsm =
      filename.endsWith('.mjs') ||
      (filename.endsWith('.js') && findPackageType(dirname)?.type === 'module');
    if (wantsEsm) {
      if (typeof requireEsmHook === 'function') {
        mod.exports = requiredEsmExports(requireEsmHook(filename, mod.parent?.filename));
        return;
      }
      const err = new Error(`Must use import to load ES Module: ${filename}`);
      err.code = 'ERR_REQUIRE_ESM';
      throw err;
    }

    const stripped = stripHashbang(source);
    // Route import() through the ESM loader with this file as referrer (not data:).
    const {
      code: body,
      changed: hasImport,
      binding: importBinding = '__import',
    } = rewriteDynamicImports(stripped);
    // Exact Node CJS wrapper arity — five parameters, plus a collision-free
    // dynamic-import binding when needed. process/Buffer/console/timers/fetch
    // come from globalThis.
    let wrapper;
    try {
      if (hasImport) {
        wrapper = new Function(
          'exports',
          'require',
          'module',
          '__filename',
          '__dirname',
          importBinding,
          `${body}\n//# sourceURL=${filename}`
        );
      } else {
        wrapper = new Function(
          'exports',
          'require',
          'module',
          '__filename',
          '__dirname',
          `${body}\n//# sourceURL=${filename}`
        );
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        // Top-level const/let of a wrapper name → Node retries as ESM when the
        // package type is not explicitly "commonjs" (type:commonjs keeps the
        // SyntaxError, with a warning suggesting "type":"module").
        const wrapperRedeclare =
          /has already been declared/i.test(err.message || '') &&
          /\b(exports|require|module|__filename|__dirname)\b/.test(err.message || '');
        if (wrapperRedeclare) {
          const pkgType = findPackageType(dirname)?.type;
          if (pkgType !== 'commonjs' && typeof requireEsmHook === 'function') {
            mod.exports = requiredEsmExports(requireEsmHook(filename, mod.parent?.filename));
            return;
          }
          if (pkgType !== 'commonjs') {
            const e = new Error(`Must use import to load ES Module: ${filename}`);
            e.code = 'ERR_REQUIRE_ESM';
            throw e;
          }
          try {
            process.stderr.write(
              `(node:${process.pid}) Warning: Failed to load the ES module: ${filename}. ` +
                `Make sure to set "type": "module" in the nearest package.json file or use the .mjs extension.\n` +
                `(Use \`node --trace-warnings ...\` to show where the warning was created)\n`
            );
          } catch {
            /* ignore */
          }
        }
        // Node's report: file:line, the line, carets under the token.
        const report = syntaxReport(source, { kind: 'commonjs', filename, error: err });
        if (report && !wrapperRedeclare) {
          Object.defineProperty(err, '_prettyStack', { value: report.stack, configurable: true, writable: true });
          err.stack = report.stack;
          throw err;
        }
        const first = body.split('\n')[0] ?? '';
        const named = /\b(exports|require|module|__filename|__dirname)\b/.exec(first);
        let caretAt = named ? named.index : first.indexOf(';');
        if (caretAt < 0) caretAt = Math.max(0, first.length - 1);
        const caret = `${' '.repeat(caretAt)}^`;
        const pretty = `${filename}:1\n${first}\n${caret}\n\n${err.name}: ${err.message}`;
        Object.defineProperty(err, '_prettyStack', { value: pretty, configurable: true, writable: true });
        err.stack = pretty;
      }
      throw err;
    }
    if (hasImport) {
      const __import = (spec, options) => {
        if (typeof importModuleHook !== 'function') {
          return Promise.reject(
            new Error('slicc-jsh: dynamic import() is not available in this context')
          );
        }
        return importModuleHook(String(spec), filename, options);
      };
      const require = makeRequire(filename, mod);
      wrapper.call(mod.exports, mod.exports, require, mod, filename, dirname, __import);
      return;
    }
    mod._compile(wrapper, filename);
  }

  function warnCircular(prop) {
    try {
      process.stderr.write(
        `(node:${process.pid}) Warning: Accessing non-existent property '${String(prop)}' of module exports inside circular dependency\n` +
          `(Use \`node --trace-warnings ...\` to show where the warning was created)\n`
      );
    } catch {
      /* ignore */
    }
  }

  /** Proxy used only when another module require()s an incomplete module (true cycle). */
  function circularExportsProxy(mod) {
    if (mod._circularProxy) return mod._circularProxy;
    const target = mod.exports;
    const proxy = new Proxy(target, {
      get(obj, prop, receiver) {
        if (
          !mod.loaded &&
          typeof prop === 'string' &&
          !(prop in obj) &&
          prop !== '__esModule'
        ) {
          warnCircular(prop);
        }
        return Reflect.get(obj, prop, receiver);
      },
      set(obj, prop, value, receiver) {
        return Reflect.set(obj, prop, value, receiver);
      },
      has(obj, prop) {
        return Reflect.has(obj, prop);
      },
      ownKeys(obj) {
        return Reflect.ownKeys(obj);
      },
      getOwnPropertyDescriptor(obj, prop) {
        return Reflect.getOwnPropertyDescriptor(obj, prop);
      },
    });
    mod._circularProxy = proxy;
    // Keep mod.exports as the plain object so the defining module does not warn
    // on its own reads; circular importers receive the proxy.
    return proxy;
  }

  function loadFile(filename, parent) {
    if (cache[filename]) {
      const existing = cache[filename];
      if (!existing.loaded) return circularExportsProxy(existing);
      return existing.exports;
    }
    const mod = new Module(filename, parent);
    cache[filename] = mod;
    if (parent) parent.children.push(mod);

    if (filename.endsWith('.node')) {
      const err = new Error(`Cannot load native addon: ${filename}`);
      err.code = 'ERR_DLOPEN_FAILED';
      throw err;
    }

    // .mjs always goes through the ESM hook when present.
    if (filename.endsWith('.mjs') && typeof requireEsmHook === 'function') {
      try {
        mod.exports = requiredEsmExports(requireEsmHook(filename, mod.parent?.filename));
        mod.loaded = true;
        return mod.exports;
      } catch (err) {
        delete cache[filename];
        throw err;
      }
    }

    const ext =
      filename.endsWith('.json')
        ? '.json'
        : filename.endsWith('.cjs')
          ? '.cjs'
          : filename.endsWith('.mjs')
            ? '.js'
            : '.js';
    const loader = Module._extensions[ext] || Module._extensions['.js'];
    try {
      // Call as a method so CallSites report Object..js / Module._compile.
      loader.call(Module._extensions, mod, filename);
    } catch (err) {
      delete cache[filename];
      throw err;
    }
    mod.loaded = true;
    return mod.exports;
  }

  let mainModule = null;

  function makeRequire(parentFilename, parentModule) {
    const require = (request) => {
      const resolved = resolver.resolve(request, parentFilename, [parentFilename]);
      if (resolved.type === 'builtin') return builtins.load(resolved.id);
      return loadFile(resolved.filename, parentModule ?? null);
    };
    require.resolve = (request) => {
      const resolved = resolver.resolve(request, parentFilename, [parentFilename]);
      if (resolved.type === 'builtin') {
        // Node keeps a node: prefix when the request used one.
        return request.startsWith('node:') ? `node:${resolved.id}` : resolved.id;
      }
      return resolved.filename;
    };
    require.resolve.paths = () => null;
    require.cache = cache;
    Object.defineProperty(require, 'main', {
      get: () => mainModule,
      configurable: true,
    });
    require.extensions = Module._extensions;
    return require;
  }

  function runMain(filename, source, opts = {}) {
    const setMain = opts.setMain !== false;
    const mod = new Module(filename === '[stdin]' || filename === '[eval]' ? filename : '.', null);
    mod.filename = filename;
    mod.id = filename === '[stdin]' || filename === '[eval]' ? filename : '.';
    mod.path = filename.startsWith('[') ? '.' : path.dirname(filename);
    mod.paths = nodeModulePaths(filename.startsWith('[') ? process.cwd() : path.dirname(filename));
    cache[filename] = mod;
    // Node leaves require.main unset for piped [stdin] scripts (typeof → 'undefined').
    mainModule = setMain ? mod : undefined;
    if (filename.startsWith('[')) {
      compile(mod, source, filename);
    } else {
      // File entry: go through extensions['.js'] so CallSites include Object..js
      // below Module._compile (Node's Module.load path).
      Module._extensions['.js'].call(Module._extensions, mod, filename);
    }
    mod.loaded = true;
    return mod.exports;
  }

  return {
    Module,
    createRequire: Module.createRequire,
    runMain,
    makeRequire,
    loadFile,
    setRequireEsmHook,
    setImportModuleHook,
    findPackageType,
  };
}
