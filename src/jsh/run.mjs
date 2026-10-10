/**
 * The `.jsh` layer shared by the kernel `jsh` (src/jsh.mjs) and the host
 * `jsh` (src/host/jsh.mjs). See docs/design/run-outside-slicc.md.
 *
 * A `.jsh` file is the body of an async function, run sloppy, with slicc v6's
 * parameters. Its `require` is the engine's Node `require` from the script's
 * location, plus `sliccy:` modules. `fs` is the engine's Node `fs`.
 */
import pkg from '../../package.json' with { type: 'json' };
import { attachParseFlags } from './parse-flags.mjs';
import { createSliccyResolver } from './sliccy/index.mjs';

export const JSH_VERSION = pkg.version;

/** The wrapper's parameters, in slicc v6's order (`runUserCode`). */
export const JSH_PARAMS = Object.freeze([
  'process',
  'console',
  'require',
  'module',
  'exports',
  'fetch',
  '__dirname',
  '__filename',
]);

export const JSH_USAGE = `Usage: jsh [--version | --help] <script.jsh> [args...]

Runs a .jsh script: the body of an async function with process, console,
require, module, exports, fetch, __dirname and __filename in scope.
`;

/**
 * Parse `jsh`'s own argv (without argv[0]). Only the first argument can be
 * an option; everything after the script belongs to the script.
 */
export function parseJshArgv(args) {
  let i = 0;
  const first = args[0];
  if (first === '--version' || first === '-v') return { action: 'version' };
  if (first === '--help' || first === '-h') return { action: 'help' };
  if (first === '--') i = 1;
  else if (first?.startsWith('-') && first !== '-') {
    return { action: 'error', message: `jsh: bad option: ${first}`, status: 9 };
  }
  if (i >= args.length) return { action: 'usage' };
  return { action: 'run', script: args[i], args: args.slice(i + 1) };
}

/** Drop a BOM and blank a leading `#!` line, keeping line numbers. */
export function prepareSource(source) {
  let text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (text.startsWith('#!')) {
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl);
  }
  return text;
}

/**
 * The wrapper's header shares the body's first line, so line numbers in
 * stack traces are the file's own.
 */
export function wrapSource(body) {
  return `(async function (${JSH_PARAMS.join(', ')}) {${body}\n})`;
}

function dirnameOf(path) {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '/';
  return path.slice(0, idx);
}

function wrapRequire(baseRequire, requireSliccy, module) {
  const require = (id) =>
    typeof id === 'string' && id.startsWith('sliccy:') ? requireSliccy(id) : baseRequire(id);
  const resolve = (id, options) =>
    typeof id === 'string' && id.startsWith('sliccy:') ? id : baseRequire.resolve(id, options);
  resolve.paths = (id) => baseRequire.resolve.paths?.(id) ?? null;
  require.resolve = resolve;
  require.cache = baseRequire.cache;
  require.main = module;
  return require;
}

/**
 * Run one `.jsh` file. `engine` supplies what differs between the kernel and
 * the host:
 *
 * - `readSource(filename) → string`, `compile(code, filename) → function`
 * - `createRequire(filename)`, `selfRequire` (or null)
 * - `writeStdout(s)`, `writeStderr(s)` (synchronous), `stdoutIsTTY`
 * - `spawn(argv, { stdin }) → { kill(sig), done }`, `shell` (argv prefix)
 * - `fetch`, `isExit(err)`, `exit(code)`
 *
 * Resolves when the script body settles; the process then lives on until its
 * event loop is empty, as in Node. A throw prints the stack and exits 1.
 */
export async function runJsh({ filename, engine, process, console }) {
  let source;
  try {
    source = engine.readSource(filename);
  } catch (err) {
    engine.writeStderr(`jsh: cannot open ${filename}: ${err?.code ?? err?.message ?? err}\n`);
    return engine.exit(1);
  }

  attachParseFlags(process.argv);
  try {
    process.versions.jsh = JSH_VERSION;
  } catch {
    /* frozen versions: leave it */
  }

  const dirname = dirnameOf(filename);
  const module = {
    id: '.',
    filename,
    path: dirname,
    exports: {},
    loaded: false,
    children: [],
    paths: [],
  };
  const baseRequire = engine.createRequire(filename);
  const requireSliccy = createSliccyResolver({ engine, process, require: baseRequire });
  const require = wrapRequire(baseRequire, requireSliccy, module);

  try {
    const fn = engine.compile(wrapSource(prepareSource(source)), filename);
    await fn(process, console, require, module, module.exports, engine.fetch, dirname, filename);
    module.loaded = true;
  } catch (err) {
    if (engine.isExit(err)) return engine.exit(err.code);
    engine.writeStderr(`${err?.stack ?? err}\n`);
    return engine.exit(1);
  }
  return undefined;
}
