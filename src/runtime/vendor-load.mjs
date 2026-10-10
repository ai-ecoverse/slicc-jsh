/**
 * Lazy-load vendored CJS bundles from the installed package's dist/vendor/.
 * Keeps cold `node -e 0` free of readable-stream / string_decoder parse cost.
 */

const decoder = new TextDecoder();
const cache = new Map();

function evalCjs(source, filename) {
  const module = { exports: {} };
  const require = (id) => {
    throw new Error(`vendor bundle unexpected require(${JSON.stringify(id)}) in ${filename}`);
  };
  const fn = new Function('exports', 'module', 'require', '__filename', '__dirname', source);
  fn(module.exports, module, require, filename, '/');
  return module.exports;
}

/**
 * @param {object} opts
 * @param {object} opts.ctx kernel ctx with sync.fs
 * @param {string} opts.packageRoot e.g. /node_modules/@ai-ecoverse/slicc-jsh
 * @param {string} opts.name file under dist/vendor/ without extension
 * @param {object} [opts.globals] set on globalThis during eval (process, Buffer)
 */
export function loadVendorCjs({ ctx, packageRoot, name, globals = {} }) {
  const key = `${packageRoot}:${name}`;
  if (cache.has(key)) return cache.get(key);

  const path = `${packageRoot}/dist/vendor/${name}.cjs`;
  const bytes = ctx.sync.fs.readFile(path);
  const source = typeof bytes === 'string' ? bytes : decoder.decode(bytes);

  const saved = {};
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = globalThis[k];
    globalThis[k] = v;
  }
  try {
    const exports = evalCjs(source, path);
    cache.set(key, exports);
    return exports;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}
