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
    const require = makeRequire(filename, mod);
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
        err.stack = `${filename}:1\n${first}\n${caret}\n\n${err.name}: ${err.message}`;
      }
      throw err;
    }
    wrapper.call(
      mod.exports,
      mod.exports,
      require,
      mod,
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
  }

  function loadFile(filename, parent) {
    if (cache[filename]) return cache[filename].exports;
    const mod = new Module(filename, parent);
    cache[filename] = mod;
    if (parent) parent.children.push(mod);

    if (filename.endsWith('.json')) {
      mod.exports = JSON.parse(decoder.decode(fs.readFile(filename)));
      mod.loaded = true;
      return mod.exports;
    }
    if (filename.endsWith('.node')) {
      const err = new Error(`Cannot load native addon: ${filename}`);
      err.code = 'ERR_DLOPEN_FAILED';
      throw err;
    }

    const source = decoder.decode(fs.readFile(filename));
    try {
      compile(mod, source, filename);
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

  function runMain(filename, source) {
    const mod = new Module('.', null);
    mod.filename = filename;
    mod.id = '.';
    mod.path = path.dirname(filename);
    cache[filename] = mod;
    mainModule = mod;
    compile(mod, source, filename);
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
