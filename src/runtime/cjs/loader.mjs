import { createPath } from '../path.mjs';
import { createBuiltins } from './builtins.mjs';
import { errRequireEsm } from './errors.mjs';
import { createResolver } from './resolve.mjs';

const decoder = new TextDecoder();

/**
 * Synchronous CJS module system over ctx.sync.
 */
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

  const resolver = createResolver({ fs, path, readPackageJson });
  const builtins = createBuiltins({ ctx, process, Buffer, console, path, handles, timers });
  const cache = Object.create(null);

  function Module(id, parent) {
    this.id = id;
    this.filename = id;
    this.path = path.dirname(id);
    this.exports = {};
    this.parent = parent ?? null;
    this.loaded = false;
    this.children = [];
    this.paths = [];
  }
  Module._cache = cache;
  Module.builtinModules = [
    'assert',
    'assert/strict',
    'buffer',
    'console',
    'events',
    'fs',
    'fs/promises',
    'module',
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
  Module.createRequire = (filename) => {
    const parent =
      typeof filename === 'string'
        ? filename
        : filename?.href
          ? filename.pathname
          : `${process.cwd()}/`;
    return makeRequire(parent);
  };
  Module.prototype.require = function require(id) {
    return makeRequire(this.filename)(id);
  };

  /**
   * Run the compiled wrapper — named like Node's Module._compile so CallSites
   * can be remapped to node:internal/modules/cjs/loader.
   */
  Module.prototype._compile = function _compile(wrapper, filename) {
    const dirname = path.dirname(filename);
    const require = makeRequire(filename, this);
    wrapper.call(
      this.exports,
      this.exports,
      require,
      this,
      filename,
      dirname,
      process,
      console,
      Buffer,
      timers.setTimeout,
      timers.clearTimeout,
      timers.setInterval,
      timers.clearInterval,
      (fn, ...args) => timers.setTimeout(fn, 0, ...args),
      timers.clearTimeout,
      fetchBinding ?? globalThis.fetch,
      webSocketBinding ?? globalThis.WebSocket
    );
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

  builtins.moduleApi.Module = Module;
  builtins.moduleApi.createRequire = Module.createRequire;
  builtins.moduleApi.builtinModules = Module.builtinModules;

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

  function compile(mod, source, filename) {
    const dirname = path.dirname(filename);
    if (filename.endsWith('.mjs')) {
      const err = new Error(
        `slicc-jsh: ESM modules are not supported yet (planned for M2): ${filename}`
      );
      err.code = 'ERR_REQUIRE_ESM';
      throw err;
    }
    if (filename.endsWith('.js')) {
      const pkg = findPackageType(dirname);
      if (pkg?.type === 'module') {
        const err = new Error(
          `slicc-jsh: ESM modules are not supported yet (planned for M2): ${filename}`
        );
        err.code = 'ERR_REQUIRE_ESM';
        throw err;
      }
    }

    const body = stripHashbang(source);
    // No leading "use strict" line so user line 1 maps to Function body line 1
    // after the engine's implicit prologue; sourceURL names the file for stacks.
    let wrapper;
    try {
      wrapper = new Function(
        'exports',
        'require',
        'module',
        '__filename',
        '__dirname',
        'process',
        'console',
        'Buffer',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'fetch',
        'WebSocket',
        `${body}\n//# sourceURL=${filename}`
      );
    } catch (err) {
      if (err instanceof SyntaxError) {
        const first = body.split('\n')[0] ?? '';
        // Prefer caret under the first `;` / unexpected token when present.
        let caretAt = first.indexOf(';');
        if (caretAt < 0) caretAt = Math.max(0, first.length - 1);
        const caret = `${' '.repeat(caretAt)}^`;
        const pretty = `${filename}:1\n${first}\n${caret}\n\n${err.name}: ${err.message}`;
        err._prettyStack = pretty;
        err.stack = pretty;
      }
      throw err;
    }
    // Run via Module._compile so CallSites include a remappable loader frame.
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

    const ext =
      filename.endsWith('.json') ? '.json' : filename.endsWith('.cjs') ? '.cjs' : '.js';
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
    require.extensions = { '.js': true, '.cjs': true, '.json': true };
    return require;
  }

  function runMain(filename, source, opts = {}) {
    const setMain = opts.setMain !== false;
    const mod = new Module(filename === '[stdin]' || filename === '[eval]' ? filename : '.', null);
    mod.filename = filename;
    mod.id = filename === '[stdin]' || filename === '[eval]' ? filename : '.';
    mod.path = filename.startsWith('[') ? '.' : path.dirname(filename);
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
  };
}
