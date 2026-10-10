import { createPath } from '../path.mjs';
import { createBuiltins } from './builtins.mjs';
import { errRequireEsm } from './errors.mjs';
import { createResolver } from './resolve.mjs';

const decoder = new TextDecoder();

/**
 * Synchronous CJS module system over ctx.sync.
 */
export function createCjs({ ctx, process, Buffer, console, timers }) {
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
  const builtins = createBuiltins({ ctx, process, Buffer, console, path });
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

  function compile(mod, source, filename) {
    const dirname = path.dirname(filename);
    const require = makeRequire(filename, mod);
    if (filename.endsWith('.mjs')) throw errRequireEsm(filename);
    if (filename.endsWith('.js')) {
      const pkg = findPackageType(dirname);
      if (pkg?.type === 'module') throw errRequireEsm(filename);
    }

    const wrapper = new Function(
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
      `"use strict";\n${source}\n//# sourceURL=${filename}`
    );
    wrapper(
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
      timers.clearTimeout
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
      // Node returns the bare id for builtins (not node:…).
      if (resolved.type === 'builtin') return resolved.id;
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
    const mod = new Module(filename, null);
    mod.filename = filename;
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
