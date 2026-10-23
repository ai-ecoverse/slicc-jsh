/**
 * Parse `node` argv the way Node 22 does for -e / -p / -v / -h / script.js.
 * `argv` is ctx.argv: [argv0, ...args].
 */
import { NODE_ENV_FLAGS } from './node-env-flags.mjs';
import { ENV_ALIASES, ENV_VALUED } from './node-env-options.mjs';

// Options that only set behaviour; kept in execArgv as Node does.
const BOOLEAN_FLAGS = new Set([
  '--preserve-symlinks',
  '--preserve-symlinks-main',
  '--no-warnings',
  '--no-deprecation',
  '--trace-warnings',
  '--trace-deprecation',
  '--throw-deprecation',
  '--pending-deprecation',
  '--expose-internals',
  // Node prints a thrown non-Error's site with it; accepted (the report is the usual one).
  '--trace-uncaught',
  // Node prints the stack on SIGINT with it; accepted (no stack is printed).
  '--trace-sigint',
  // Source maps for stacks and error reports (source-maps.mjs).
  '--enable-source-maps',
  // process.report's settings (process-members.mjs).
  '--report-compact',
  '--report-exclude-env',
  '--report-exclude-network',
  '--report-on-fatalerror',
  '--report-on-signal',
  '--report-uncaught-exception',
]);

/** V8's report for a flag it couldn't take, then Node's "bad option" for it and for the flags Node 22.22 passes V8 after it. */
function v8FlagError(argv0, lines, arg) {
  const after = [
    '--harmony-import-attributes',
    '--no-harmony-import-assertions',
    '--experimental-wasm-imported-strings',
    '--experimental-wasm-memory64',
    '--experimental-wasm-exnref',
  ];
  return [...lines, 'Try --help for options', ...[arg, ...after].map((f) => `${argv0}: bad option: ${f}`)].join('\n');
}
const VALUED_FLAGS = [
  '--disable-warning',
  '--redirect-warnings',
  '--input-type',
  '--title',
  '--report-dir',
  '--report-directory',
  '--report-filename',
  '--report-signal',
  '--trace-event-categories',
  '--trace-event-file-pattern',
  '--max-http-header-size',
];
const INPUT_TYPES = ['module', 'commonjs', 'module-typescript', 'commonjs-typescript'];

/** --input-type's value from execArgv (`--input-type=x` or `--input-type x`), or undefined. */
/**
 * A Worker's execArgv without the options that choose what runs (-e, -p,
 * --check, -i, with their values): Node keeps them in the worker's
 * process.execArgv, inert, and runs the worker's own entry.
 */
export function withoutEntryOptions(execArgv = []) {
  const out = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i];
    if (/^(-e|--eval|-p|--print|-pe|-ep)$/.test(arg)) {
      i++;
      continue;
    }
    if (/^(--eval|--print)=/.test(arg) || /^(-c|--check|-i|--interactive)$/.test(arg)) continue;
    out.push(arg);
  }
  return out;
}

/**
 * Node 22.22.0's per-process options: a Worker refuses them in its execArgv
 * and in its env's NODE_OPTIONS. Recorded by trying each name in its option
 * table (require('internal/options')) both ways; their `--no-` forms too.
 */
const WORKER_PER_PROCESS = new Set([
  '--debug-arraybuffer-allocations', '--disable-proto', '--disable-wasm-trap-handler', '--enable-fips',
  '--force-fips', '--icu-data-dir', '--node-memory-debug', '--node-snapshot', '--openssl-config',
  '--openssl-legacy-provider', '--openssl-shared-config', '--prof-process', '--report-compact', '--report-dir',
  '--report-directory', '--report-filename', '--report-on-fatalerror', '--secure-heap', '--secure-heap-min',
  '--snapshot-blob', '--title', '--tls-cipher-list', '--trace-event-categories', '--trace-event-file-pattern',
  '--trace-events-enabled', '--trace-sigint', '--use-bundled-ca', '--use-largepages', '--use-openssl-ca',
  '--use-system-ca', '--v8-pool-size', '--zero-fill-buffers',
]);
/** And what only its execArgv refuses: V8's options, and the ones that aren't a program's. */
const WORKER_EXEC_REFUSED = new Set([
  '--abort-on-uncaught-exception', '--completion-bash', '--debug', '--debug-brk',
  '--disallow-code-generation-from-strings', '--enable-etw-stack-walking', '--experimental-sea-config',
  '--experimental-shadow-realm', '--expose-gc', '--harmony', '--harmony-shadow-realm', '--help',
  '--huge-max-old-generation-size', '--interpreted-frames-native-stack', '--jitless', '--max-old-space-size',
  '--max-semi-space-size', '--perf-basic-prof', '--perf-basic-prof-only-functions', '--perf-prof',
  '--perf-prof-unwinding-info', '--prof', '--run', '--security-revert', '--stack-trace-limit', '--use-strict',
  '--v8-options', '--version', '--watch', '--watch-path', '-h', '-v',
]);
// The one V8 option the worker parser reads with its value before refusing it.
const WORKER_V8_VALUED = new Set(['--stack-trace-limit']);
const inSet = (set, name) => set.has(name) || (name.startsWith('--no-') && set.has(`--${name.slice(5)}`));
const refusedInWorker = (name) => inSet(WORKER_PER_PROCESS, name) || inSet(WORKER_EXEC_REFUSED, name);

/**
 * What Node's Worker constructor says of an execArgv it refuses (after
 * "Initiated Worker with invalid execArgv flags: "), or null. As its parser
 * reads them: in order, up to the first word that isn't an option; a flag
 * whose value is missing is that error alone; otherwise every flag the
 * worker can't take, as written.
 */
export function workerExecArgvError(execArgv) {
  const invalid = [];
  for (let i = 0; i < execArgv.length; i++) {
    const word = execArgv[i];
    if (!word.startsWith('-') || word === '-' || word === '--') break;
    const norm = normalizeOption(word);
    const name = norm.startsWith('--') ? norm.split('=')[0] : norm;
    const next = execArgv[i + 1];
    // -e, -p, --check and -i are inert in a worker, once whole (-pe is --eval's).
    if (/^(-e|--eval|-pe|-ep)$/.test(word)) {
      if (missingValue(next)) return `${word.length === 3 ? '--eval' : word} requires an argument`;
      i++;
      continue;
    }
    if (word === '--eval=' || word === '--print=') return `${word} requires an argument`;
    if (word === '-p' || word === '--print') {
      if (!missingValue(next)) i++;
      continue;
    }
    if (/^--(eval|print)=/.test(word) || /^(-c|--check|-i|--interactive)$/.test(word)) continue;
    if (WORKER_V8_VALUED.has(name) && name === norm) {
      if (missingValue(next)) return `${word} requires an argument`;
      i++;
      invalid.push(word);
      continue;
    }
    if (refusedInWorker(name) || singleDashV8(word)) {
      invalid.push(word);
      continue;
    }
    const alone = parseNodeArgv(['node', word, '-e', '0']);
    if (!alone.error) continue;
    if (/requires an argument/.test(alone.error)) {
      if (missingValue(next)) return `${word} requires an argument`;
      if (!parseNodeArgv(['node', word, next, '-e', '0']).error) {
        i++;
        continue;
      }
    }
    invalid.push(word);
  }
  return invalid.length ? invalid.join(', ') : null;
}

/**
 * What Node's Worker constructor says of NODE_OPTIONS in the env it was
 * given (after "Initiated Worker with invalid NODE_OPTIONS env variable: "),
 * or null: its per-process options aren't allowed there.
 */
export function workerNodeOptionsError(text) {
  if (typeof text !== 'string' || text === '') return null;
  const parsed = parseNodeOptions(text, 'node', { refuse: 'error' });
  return parsed.error ? parsed.error.replace(/^node: /, '').trimEnd() : null;
}

/**
 * A worker's command line, as Node gives a Worker's thread: its execArgv
 * (the Worker's option, else its parent's), its script (or its eval code, or
 * a data: URL's module), then its argv. An eval worker's argv[1] is
 * `[worker eval]`.
 */
export function workerCommandLine(data) {
  // (Its execArgv's -e, -p, --check or -i, from its parent's for one, are
  // left as they are in process.execArgv: they don't choose what it runs.)
  const argv = ['node', ...withoutEntryOptions(data.execArgv)];
  if (data.eval !== undefined) argv.push('-e', data.eval, '--', ...data.argv);
  // A data: URL's module runs as itself (its import.meta.url, its stack's
  // name), as Node's worker runs it.
  else if (data.url !== undefined) argv.push('--input-type=module', '-e', `import ${JSON.stringify(data.url)};`, '--', ...data.argv);
  else argv.push(data.file, ...data.argv);
  // Its NODE_OPTIONS: its env's, or (with the parent's env) the parent's own,
  // without what a worker doesn't take.
  const parsed = parseNodeArgv(argv, { nodeOptions: data.nodeOptions, refuse: data.nodeOptionsGiven ? 'error' : 'drop' });
  // An eval worker's argv[1] is `[worker eval]`; a data: URL's has none.
  if (data.eval !== undefined) parsed.processArgv = [parsed.processArgv[0], '[worker eval]', ...data.argv];
  else if (data.url !== undefined) parsed.processArgv = [parsed.processArgv[0], ...data.argv];
  // A worker's process.execArgv is its execArgv option alone, without the
  // -e the eval and data: URL ways run it with.
  if (!parsed.error) parsed.execArgv = [...(data.execArgv ?? [])];
  return parsed;
}

export function inputTypeOf(execArgv = []) {
  let type;
  for (let i = 0; i < execArgv.length; i++) {
    if (execArgv[i] === '--input-type') type = execArgv[++i];
    else if (execArgv[i].startsWith('--input-type=')) type = execArgv[i].slice(13);
  }
  return type;
}

/**
 * NODE_OPTIONS as Node 22.22.0 reads it (ParseNodeOptionsEnvVar, then the
 * option parser in its environment mode): words split on spaces, `"…"`
 * groups (a backslash escapes the next character inside), parsing stops at
 * the first word that isn't an option, and every option must be one Node
 * allows there. Answers the words jsh applies (in CLI form, before the
 * command line's), or Node's error.
 */
/**
 * `refuse`: a worker's NODE_OPTIONS, where Node's per-process options are
 * 'error' (its env's) or dropped ('drop', the parent's own).
 */
export function parseNodeOptions(text, argv0 = 'node', { watch = false, refuse } = {}) {
  const words = [];
  let inString = false;
  let fresh = true;
  for (let i = 0; i < text.length; i++) {
    let c = text[i];
    if (c === '\\' && inString) {
      if (i + 1 === text.length) return { error: `${argv0}: invalid value for NODE_OPTIONS (invalid escape)\n`, status: 9 };
      c = text[++i];
    } else if (c === ' ' && !inString) {
      fresh = true;
      continue;
    } else if (c === '"') {
      inString = !inString;
      continue;
    }
    if (fresh) {
      words.push(c);
      fresh = false;
    } else {
      words[words.length - 1] += c;
    }
  }
  if (inString) return { error: `${argv0}: invalid value for NODE_OPTIONS (unterminated string)\n`, status: 9 };

  const allowed = new Set(NODE_ENV_FLAGS);
  const apply = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    // The first argument that isn't an option ends them; the rest is ignored.
    if (!word.startsWith('-') || word === '-') break;
    // A short option takes no `=` (`-C=foo` is a name of its own).
    const eq = word.startsWith('--') ? word.indexOf('=') : -1;
    const raw = eq === -1 ? word : word.slice(0, eq);
    const name = normalizeOption(raw);
    const negated = `--${name.slice(5)}`;
    if (name.startsWith('--no-') && (ENV_VALUED.has(negated) || ENV_VALUED.has(ENV_ALIASES[negated]?.[0]))) {
      return { error: `${argv0}: ${raw} is an invalid negation because it is not a boolean option`, status: 9 };
    }
    if (refuse === 'drop' && inSet(WORKER_PER_PROCESS, name)) {
      if (eq === -1 && ENV_VALUED.has(name) && !missingValue(words[i + 1])) i++;
      continue;
    }
    // Node names an option given with a value with its `=` (`--eval= is not allowed`).
    if (word === '--' || !allowed.has(name) || (refuse && inSet(WORKER_PER_PROCESS, name))) return { error: `${argv0}: ${eq === -1 ? raw : `${raw}=`} is not allowed in NODE_OPTIONS`, status: 9 };
    const alias = ENV_ALIASES[name];
    const canonical = alias?.length === 1 ? alias[0] : name;
    const takesValue = ENV_VALUED.has(canonical);
    if (takesValue && eq === -1) {
      if (missingValue(words[i + 1])) return { error: `${argv0}: ${raw} requires an argument`, status: 9 };
      apply.push(name, words[++i]);
    } else if (takesValue && eq === word.length - 1) {
      return { error: `${argv0}: ${word} requires an argument`, status: 9 };
    } else {
      apply.push(eq === -1 ? name : `${name}${word.slice(eq)}`);
    }
  }
  // What jsh knows of them goes through its own parser; the rest Node would
  // apply, and jsh has no use for (accepted, as there).
  const known = [];
  for (let i = 0; i < apply.length; i++) {
    const word = apply[i];
    const name = word.split('=')[0];
    const valued = !word.includes('=') && ENV_VALUED.has(ENV_ALIASES[name]?.length === 1 ? ENV_ALIASES[name][0] : name);
    if (jshKnows(word, watch)) known.push(word, ...(valued ? [apply[i + 1]] : []));
    if (valued) i++;
  }
  return { args: known };
}

/** An option jsh's command line takes (see parseNodeArgv). */
function jshKnows(word, watch = false) {
  const name = word.split('=')[0];
  if (word === '--trace-events-enabled') return true;
  // The watch options, where the kernel can watch (as on the command line).
  if (watch && /^--(no-)?watch(-path|-kill-signal|-preserve-output)?$/.test(name)) return true;
  return (
    booleanToggle(name) !== null ||
    VALUED_FLAGS.includes(name) ||
    ['-r', '--require', '--import', '--stack-trace-limit', '--max-old-space-size', '-i', '--interactive'].includes(name)
  );
}

/**
 * The command line with NODE_OPTIONS (`nodeOptions`) before it, as Node
 * applies them: their options come first (the command line's win where one
 * value counts; `-r` / `--import` lists take NODE_OPTIONS' first), and they
 * aren't in execArgv: `options` is what's in effect.
 */
/**
 * `watch`: whether this kernel can run --watch (an IPC channel to the child,
 * and fs.watch). Without it --watch and its options stay bad options.
 */
export function parseNodeArgv(argv, { nodeOptions, watch = false, refuse } = {}) {
  const argv0 = argv[0] ?? 'node';
  if (typeof nodeOptions === 'string' && nodeOptions !== '') {
    const env = parseNodeOptions(nodeOptions, argv0, { watch, refuse });
    if (env.error) return env;
    if (env.args.length > 0) {
      // (Watch mode from NODE_OPTIONS alone has no file there: Node's error.)
      const fromEnv = parseCommandLine([argv0, ...env.args], { watch });
      if (fromEnv.error) return fromEnv;
      const cli = parseCommandLine(argv, { watch });
      if (cli.error || cli.mode === 'version' || cli.mode === 'help') return cli;
      return {
        ...cli,
        options: effective([...fromEnv.canonical, ...cli.canonical]),
        preload: [...fromEnv.preload, ...cli.preload],
        imports: [...fromEnv.imports, ...cli.imports],
        v8Warnings: [...fromEnv.v8Warnings, ...cli.v8Warnings],
        interactive: cli.interactive || fromEnv.interactive,
      };
    }
  }
  const parsed = parseCommandLine(argv, { watch });
  return parsed.execArgv ? { ...parsed, options: effective(parsed.canonical) } : parsed;
}

/** The options in effect: a boolean given a value (`--no-warnings=x`, which Node takes) as itself. */
function effective(flags) {
  const out = [];
  for (const f of flags) {
    const name = f.split('=')[0];
    const toggle = booleanToggle(name);
    if (!toggle || !f.startsWith('--')) {
      out.push(f);
      continue;
    }
    // A boolean's last form wins (`--x` … `--no-x`), as in Node; it stays,
    // in order (an implication such as --report-signal's counts before it).
    for (let i = out.length - 1; i >= 0; i--) if (booleanToggle(out[i])?.key === toggle.key) out.splice(i, 1);
    out.push(toggle.on ? toggle.flag : name);
  }
  return out;
}

/**
 * A boolean option jsh takes, in either form: `--x` and `--no-x` (for
 * jsh's `--no-warnings`, `--warnings` is the other form). `flag` is jsh's
 * name for it, `on` whether this form sets it.
 */
function booleanToggle(name) {
  if (BOOLEAN_FLAGS.has(name)) return { key: name.replace(/^--no-/, '--'), flag: name, on: true };
  const other = name.startsWith('--no-') ? `--${name.slice(5)}` : name.startsWith('--') ? `--no-${name.slice(2)}` : null;
  if (other && BOOLEAN_FLAGS.has(other)) return { key: other.replace(/^--no-/, '--'), flag: other, on: false };
  return null;
}

export function normalizeOption(word) {
  if (word.length < 2 || word[0] !== '-') return word;
  const eq = word[1] === '-' ? word.indexOf('=') : -1;
  const end = eq === -1 ? word.length : eq;
  return word.slice(0, 2) + word.slice(2, end).replaceAll('_', '-') + word.slice(end);
}

const SINGLE_DASH_V8 = new Set(['stack-trace-limit', 'max-old-space-size']);

function singleDashV8(word) {
  if (!/^-[^-]/.test(word)) return null;
  const eq = word.indexOf('=');
  const name = word.slice(1, eq === -1 ? word.length : eq).replaceAll('_', '-');
  return SINGLE_DASH_V8.has(name) ? `--${name}${eq === -1 ? '' : word.slice(eq)}` : null;
}

/** Node's: a value that looks like an option isn't one (`--require --no-warnings`). */
const missingValue = (next) => next === undefined || next.startsWith('-');

function parseCommandLine(argv, { watch: watchable = false } = {}) {
  const argv0 = argv[0] ?? 'node';
  // --watch (or --watch-path): Node's watch mode runs the program in a child.
  let watch = false;
  const args = argv.slice(1);
  let evalCode;
  let print = false;
  let script;
  const userArgs = [];
  let interactive = false;
  // -c / --check: the script's syntax is checked, nothing runs (Node's check_syntax).
  let check = false;
  // -r / --require modules, in order; `node -`: the program from stdin.
  const preload = [];
  const imports = [];
  // What V8 prints about a flag it still took (stderr, before the program).
  const v8Warnings = [];
  let stdinScript = false;
  // Options that only set behaviour; kept in execArgv as Node does.
  const flags = [];
  const shown = [];
  let i = 0;
  let word;
  let arg;
  const keep = (name, ...values) => {
    flags.push(name, ...values);
    shown.push(name === arg ? word : name, ...values);
  };

  while (i < args.length) {
    word = args[i];
    arg = singleDashV8(word) ?? normalizeOption(word);
    if (arg === '--') {
      userArgs.push(...args.slice(i + 1));
      break;
    }
    if (arg === '-v' || arg === '--version') {
      return { mode: 'version', processArgv: [argv0] };
    }
    if (arg === '-h' || arg === '--help') {
      return { mode: 'help', processArgv: [argv0] };
    }
    if (arg === '-e' || arg === '--eval') {
      i += 1;
      if (missingValue(args[i])) {
        return { error: `${argv0}: ${word} requires an argument`, status: 9 };
      }
      evalCode = args[i];
      print = false;
      keep('-e', evalCode);
      i += 1;
      // Node goes on parsing options after the code, up to the first argument.
      continue;
    }
    if (arg === '-p' || arg === '--print') {
      print = true;
      i += 1;
      if (i >= args.length) {
        return { error: `${argv0}: ${word} requires an argument`, status: 9 };
      }
      evalCode = args[i];
      keep('-p', evalCode);
      i += 1;
      continue;
    }
    if (arg === '-pe') {
      i += 1;
      if (missingValue(args[i])) return { error: `${argv0}: --eval requires an argument`, status: 9 };
      print = true;
      evalCode = args[i];
      keep(arg, evalCode);
      i += 1;
      continue;
    }
    if (arg === '-r' || arg === '--require') {
      if (missingValue(args[i + 1])) return { error: `${argv0}: ${word} requires an argument`, status: 9 };
      preload.push(args[i + 1]);
      keep(arg, args[i + 1]);
      i += 2;
      continue;
    }
    if (arg.startsWith('--require=')) {
      preload.push(arg.slice(10));
      keep(arg);
      i += 1;
      continue;
    }
    // V8's own flags (only the `=` form; V8 reads them itself):
    // --stack-trace-limit=N sets Error.stackTraceLimit; --max-old-space-size=N
    // is accepted (the kernel sets a program's memory). A bad value is V8's
    // report, then Node's for the flags V8 then didn't take.
    if (arg === '--stack-trace-limit' || arg.startsWith('--stack-trace-limit=')) {
      if (!/^-?\d+$/.test(arg.slice(20))) {
        return { error: v8FlagError(argv0, [`Error: illegal value for flag ${word} of type int`], word), status: 9 };
      }
      keep(arg);
      i += 1;
      continue;
    }
    if (arg === '--max-old-space-size' || arg.startsWith('--max-old-space-size=')) {
      const value = arg.slice(21);
      const bounds = `Error: Value for flag ${word} of type size_t is out of bounds [0-18446744073709551615]`;
      // A negative size: V8 says so and goes on (with its default).
      if (/^-\d+$/.test(value)) {
        v8Warnings.push(bounds, 'Try --help for options');
        keep(arg);
        i += 1;
        continue;
      }
      if (!/^\d+$/.test(value)) {
        // Linux's V8 (strtoull doesn't take the value): just "illegal value";
        // macOS's prints the out-of-bounds line before it.
        return { error: v8FlagError(argv0, [`Error: illegal value for flag ${word} of type size_t`], word), status: 9 };
      }
      keep(arg);
      i += 1;
      continue;
    }
    // --import X / --import=X: ES modules loaded before the entry (after -r).
    if (arg === '--import') {
      if (missingValue(args[i + 1])) return { error: `${argv0}: ${word} requires an argument`, status: 9 };
      imports.push(args[i + 1]);
      keep(arg, args[i + 1]);
      i += 2;
      continue;
    }
    if (arg.startsWith('--import=')) {
      if (arg === '--import=') return { error: `${argv0}: ${word} requires an argument`, status: 9 };
      imports.push(arg.slice(9));
      keep(arg);
      i += 1;
      continue;
    }
    // `node -`: the program is stdin (even a terminal), `-` its argv[1].
    if (arg === '-' && evalCode === undefined) {
      stdinScript = true;
      userArgs.push(...args.slice(i + 1));
      break;
    }
    if (arg === '-i' || arg === '--interactive') {
      // The REPL even if stdin isn't a terminal (Node's -i); kept in execArgv.
      interactive = true;
      keep(arg);
      i += 1;
      continue;
    }
    // Node's booleans: --watch, --watch=<anything> (watch mode, whatever the
    // value, as in Node), --no-watch, and the same for
    // --watch-preserve-output. The last of --watch and --no-watch wins.
    const watchBoolean = watchable && /^--(no-)?watch(-preserve-output)?(=|$)/.exec(arg);
    if (watchBoolean && !(watchBoolean[1] && arg.includes('='))) {
      if (!watchBoolean[2]) watch = !watchBoolean[1];
      keep(arg);
      i += 1;
      continue;
    }
    if (watchable && /^--no-watch-(path|kill-signal)(=|$)/.test(arg)) {
      return { error: `${argv0}: ${word} is an invalid negation because it is not a boolean option`, status: 9 };
    }
    const watchValued = watchable && ['--watch-path', '--watch-kill-signal'].find((f) => arg === f || arg.startsWith(`${f}=`));
    if (watchValued) {
      if (watchValued === '--watch-path') watch = true;
      if (arg === watchValued) {
        if (missingValue(args[i + 1])) {
          const lines = [`${argv0}: ${word} requires an argument`];
          if (watchValued === '--watch-path') lines.push(`${argv0}: --watch requires specifying a file`);
          return { error: lines.join('\n'), status: 9 };
        }
        keep(arg, args[i + 1]);
        i += 2;
      } else if (arg === `${watchValued}=`) {
        return { error: `${argv0}: ${word} requires an argument`, status: 9 };
      } else {
        keep(arg);
        i += 1;
      }
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg) || (arg.startsWith('--') && booleanToggle(arg.split('=')[0]))) {
      keep(arg);
      i += 1;
      continue;
    }
    if (arg === '--trace-events-enabled') {
      keep(arg);
      i += 1;
      continue;
    }
    const negated = /^--no-([^=]+)/.exec(arg)?.[1];
    if (negated && [...VALUED_FLAGS, '--trace-events-enabled'].includes(`--${negated}`)) {
      return { error: `${argv0}: ${word} is an invalid negation because it is not a boolean option`, status: 9 };
    }
    const valued = VALUED_FLAGS.find((f) => arg === f || arg.startsWith(`${f}=`));
    if (valued) {
      if (arg === `${valued}=`) return { error: `${argv0}: ${word} requires an argument`, status: 9 };
      if (arg === valued) {
        if (missingValue(args[i + 1])) return { error: `${argv0}: ${word} requires an argument`, status: 9 };
        keep(arg, args[i + 1]);
        i += 2;
      } else {
        keep(arg);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('-')) {
      if (arg === '-c' || arg === '--check') {
        check = true;
        keep(arg);
        i += 1;
        continue;
      }
      return { error: `${argv0}: bad option: ${word}`, status: 9 };
    }
    // With -e / -p, the first argument and the rest are the program's.
    if (evalCode !== undefined) {
      userArgs.push(...args.slice(i));
      break;
    }
    script = arg;
    userArgs.push(...args.slice(i + 1));
    break;
  }

  const inputType = inputTypeOf(flags);
  if (inputType !== undefined && !INPUT_TYPES.includes(inputType)) {
    return {
      error: `${argv0}: --input-type must be "module","commonjs", "module-typescript" or "commonjs-typescript"`,
      status: 9,
    };
  }
  if (inputType?.endsWith('-typescript')) {
    return { error: `${argv0}: --input-type=${inputType} is not supported by slicc-jsh (no TypeScript)`, status: 9 };
  }

  if (check && evalCode !== undefined) {
    return { error: `${argv0}: either --check or --eval can be used, not both`, status: 9 };
  }

  if (watch) {
    if (evalCode !== undefined) return { error: `${argv0}: either --watch or --eval can be used, not both`, status: 9 };
    if (check) return { error: `${argv0}: either --watch or --check can be used, not both`, status: 9 };
    if (interactive) return { error: `${argv0}: either --watch or --interactive can be used, not both`, status: 9 };
    if (script === undefined && !stdinScript) return { error: `${argv0}: --watch requires specifying a file`, status: 9 };
    // Node's internal/main/watch_mode: it runs the program as given, again
    // whenever a file it loaded changes.
    return {
      mode: 'watch',
      processArgv: [argv0, ...(stdinScript ? ['-'] : [script]), ...userArgs],
      execArgv: shown,
    canonical: flags,
      preload,
      imports,
      v8Warnings,
    };
  }

  if (evalCode !== undefined) {
    return {
      mode: 'eval',
      code: evalCode,
      print,
      processArgv: [argv0, ...userArgs],
      // In Node's order: the options as given, the code where it was.
      execArgv: shown,
    canonical: flags,
      interactive,
      preload,
      imports,
      v8Warnings,
    };
  }

  if (script !== undefined) {
    return {
      mode: 'file',
      script,
      check,
      processArgv: [argv0, script, ...userArgs],
      execArgv: shown,
    canonical: flags,
      preload,
      imports,
      v8Warnings,
    };
  }

  return {
    mode: 'empty',
    processArgv: stdinScript ? [argv0, '-', ...userArgs] : [argv0],
    execArgv: shown,
    canonical: flags,
    interactive,
    preload,
    imports,
    v8Warnings,
    stdinScript,
    check,
  };
}
