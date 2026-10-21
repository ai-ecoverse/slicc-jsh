/**
 * Lazy-eval vendored CJS (readable-stream, string_decoder).
 *
 * Prefer sources embedded at build time so abi:js programs loaded via data:
 * URLs still work when the package is not at
 * /node_modules/@ai-ecoverse/slicc-jsh (pnpm global v11 layout). Fall back to
 * reading dist/vendor/ from packageRoot for older layouts / host tooling.
 */

import { VENDOR } from './vendor-embedded.mjs';

const decoder = new TextDecoder();
const cache = new Map();

function evalCjs(source, filename, requires = {}, scope = {}) {
  const module = { exports: {} };
  // Builtins a bundle leaves external (stream, util, …) come from the runtime.
  const require = (id) => {
    const bare = id.startsWith('node:') ? id.slice(5) : id;
    if (Object.prototype.hasOwnProperty.call(requires, bare)) {
      const value = requires[bare];
      return typeof value === 'function' && value.lazyRequire ? value() : value;
    }
    throw new Error(`vendor bundle unexpected require(${JSON.stringify(id)}) in ${filename}`);
  };
  const fn = new Function('exports', 'module', 'require', '__filename', '__dirname', ...Object.keys(scope), source);
  fn(module.exports, module, require, filename, '/', ...Object.values(scope));
  return module.exports;
}

function readVendorFile(ctx, packageRoot, file, text = true) {
  if (!ctx?.sync?.fs?.readFile) return null;
  const path = `${packageRoot}/dist/vendor/${file}`;
  try {
    const bytes = ctx.sync.fs.readFile(path);
    if (!text) return bytes instanceof Uint8Array ? bytes : null;
    return typeof bytes === 'string' ? bytes : decoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Resolve the installed package root that contains dist/vendor/<name>.cjs.
 * Catalog/global installs are under $PNPM_HOME/global/v11/<hash>/, not
 * /node_modules.
 */
function packageRoots(packageRoot, process) {
  const roots = [];
  if (packageRoot) roots.push(packageRoot);
  roots.push('/node_modules/@ai-ecoverse/slicc-jsh');
  const home = process?.env?.PNPM_HOME;
  const homes = [
    home,
    '/usr/local/share/pnpm',
    process?.env?.HOME ? `${process.env.HOME}/.local/share/pnpm` : null,
  ].filter(Boolean);
  return { roots, homes };
}

function findOnDisk(ctx, packageRoot, file, process, text = true) {
  const { roots, homes } = packageRoots(packageRoot, process);
  for (const root of roots) {
    const source = readVendorFile(ctx, root, file, text);
    if (source != null) return { source, path: `${root}/dist/vendor/${file}` };
  }
  const syncFs = ctx?.sync?.fs;
  if (!syncFs?.readdir || !syncFs?.exists) return null;
  for (const base of homes) {
    const v11 = `${base}/global/v11`;
    let hashes;
    try {
      hashes = syncFs.readdir(v11);
    } catch {
      continue;
    }
    for (const hash of hashes) {
      const root = `${v11}/${hash}/node_modules/@ai-ecoverse/slicc-jsh`;
      const source = readVendorFile(ctx, root, file, text);
      if (source != null) return { source, path: `${root}/dist/vendor/${file}` };
    }
  }
  return null;
}

/**
 * Unbundled (tests importing src/ under host Node, where the embedded map is
 * the placeholder): the build's dist/vendor/<name>.cjs next to this file.
 */
function fromBuildTree(file, text = true) {
  const fs = globalThis.process?.getBuiltinModule?.('node:fs');
  if (!fs || !import.meta.url.startsWith('file:')) return null;
  try {
    const bytes = fs.readFileSync(new URL(`../../dist/vendor/${file}`, import.meta.url));
    return text ? bytes.toString('utf8') : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {object} [opts.ctx] kernel ctx with sync.fs (fallback only)
 * @param {string} [opts.packageRoot] e.g. /node_modules/@ai-ecoverse/slicc-jsh
 * @param {string} opts.name file under dist/vendor/ without extension
 * @param {object} [opts.globals] set on globalThis during eval (process, Buffer)
 * @param {object} [opts.process] for PNPM_HOME / HOME discovery
 * @param {object} [opts.requires] modules the bundle's require() gets, by id
 */
export function loadVendorCjs({ ctx, packageRoot, name, globals = {}, process, requires, scope } = {}) {
  const key = name;
  if (cache.has(key)) return cache.get(key);

  let source = VENDOR[name];
  let path = `embedded:${name}`;
  if (source == null) source = fromBuildTree(`${name}.cjs`);
  if (source == null) {
    const found = findOnDisk(ctx, packageRoot, `${name}.cjs`, process ?? globals.process);
    if (!found) {
      const err = new Error(
        `slicc-jsh: vendor bundle ${name} is not embedded and was not found on disk`
      );
      err.code = 'ENOENT';
      throw err;
    }
    source = found.source;
    path = found.path;
  }

  const saved = {};
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = globalThis[k];
    globalThis[k] = v;
  }
  try {
    const exports = evalCjs(source, path, requires, scope);
    cache.set(key, exports);
    return exports;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}

export function loadVendorBinary({ ctx, packageRoot, file, process } = {}) {
  const key = `binary:${file}`;
  if (cache.has(key)) return cache.get(key);
  const bytes = fromBuildTree(file, false) ?? findOnDisk(ctx, packageRoot, file, process, false)?.source ?? null;
  if (bytes) cache.set(key, bytes);
  return bytes;
}
