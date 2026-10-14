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
];
const INPUT_TYPES = ['module', 'commonjs', 'module-typescript', 'commonjs-typescript'];

/** --input-type's value from execArgv (`--input-type=x` or `--input-type x`), or undefined. */
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
export function parseNodeOptions(text, argv0 = 'node') {
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
    // Node's names take `_` for `-` (after the leading dashes).
    const name = raw.replace(/^(-+)(.*)$/, (m, dashes, rest) => dashes + rest.replace(/_/g, '-'));
    if (name.startsWith('--no-') && ENV_VALUED.has(`--${name.slice(5)}`)) {
      return { error: `${argv0}: ${raw} is an invalid negation because it is not a boolean option`, status: 9 };
    }
    if (word === '--' || !allowed.has(name)) return { error: `${argv0}: ${raw} is not allowed in NODE_OPTIONS`, status: 9 };
    const alias = ENV_ALIASES[name];
    const canonical = alias?.length === 1 ? alias[0] : name;
    const takesValue = ENV_VALUED.has(canonical);
    if (takesValue && eq === -1) {
      if (missingValue(words[i + 1])) return { error: `${argv0}: ${raw} requires an argument`, status: 9 };
      apply.push(word, words[++i]);
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
    if (jshKnows(word)) known.push(word, ...(valued ? [apply[i + 1]] : []));
    if (valued) i++;
  }
  return { args: known };
}

/** An option jsh's command line takes (see parseNodeArgv). */
function jshKnows(word) {
  const name = word.split('=')[0];
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
export function parseNodeArgv(argv, { nodeOptions } = {}) {
  const argv0 = argv[0] ?? 'node';
  if (typeof nodeOptions === 'string' && nodeOptions !== '') {
    const env = parseNodeOptions(nodeOptions, argv0);
    if (env.error) return env;
    if (env.args.length > 0) {
      const fromEnv = parseCommandLine([argv0, ...env.args]);
      if (fromEnv.error) return fromEnv;
      const cli = parseCommandLine(argv);
      if (cli.error || cli.mode === 'version' || cli.mode === 'help') return cli;
      return {
        ...cli,
        options: effective([...fromEnv.execArgv, ...cli.execArgv]),
        preload: [...fromEnv.preload, ...cli.preload],
        imports: [...fromEnv.imports, ...cli.imports],
        v8Warnings: [...fromEnv.v8Warnings, ...cli.v8Warnings],
        interactive: cli.interactive || fromEnv.interactive,
      };
    }
  }
  const parsed = parseCommandLine(argv);
  return parsed.execArgv ? { ...parsed, options: effective(parsed.execArgv) } : parsed;
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
    // A boolean's last form wins (`--x` … `--no-x`), as in Node.
    for (let i = out.length - 1; i >= 0; i--) if (booleanToggle(out[i])?.key === toggle.key) out.splice(i, 1);
    if (toggle.on) out.push(toggle.flag);
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

/** Node's: a value that looks like an option isn't one (`--require --no-warnings`). */
const missingValue = (next) => next === undefined || next.startsWith('-');

function parseCommandLine(argv) {
  const argv0 = argv[0] ?? 'node';
  const args = argv.slice(1);
  let evalCode;
  let print = false;
  let script;
  const userArgs = [];
  let interactive = false;
  // -r / --require modules, in order; `node -`: the program from stdin.
  const preload = [];
  const imports = [];
  // What V8 prints about a flag it still took (stderr, before the program).
  const v8Warnings = [];
  let stdinScript = false;
  // Options that only set behaviour; kept in execArgv as Node does.
  const flags = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
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
        return { error: `${argv0}: ${arg} requires an argument`, status: 9 };
      }
      evalCode = args[i];
      print = false;
      flags.push('-e', evalCode);
      i += 1;
      // Node goes on parsing options after the code, up to the first argument.
      continue;
    }
    if (arg === '-p' || arg === '--print') {
      print = true;
      i += 1;
      if (i >= args.length) {
        return { error: `${argv0}: ${arg} requires an argument`, status: 9 };
      }
      evalCode = args[i];
      flags.push('-p', evalCode);
      i += 1;
      continue;
    }
    if (arg.startsWith('-e') && arg.length > 2) {
      evalCode = arg.slice(2);
      print = false;
      flags.push('-e', evalCode);
      i += 1;
      continue;
    }
    if (arg.startsWith('-p') && arg.length > 2) {
      print = true;
      evalCode = arg.slice(2);
      flags.push('-p', evalCode);
      i += 1;
      continue;
    }
    if (arg === '-r' || arg === '--require') {
      if (missingValue(args[i + 1])) return { error: `${argv0}: ${arg} requires an argument`, status: 9 };
      preload.push(args[i + 1]);
      flags.push(arg, args[i + 1]);
      i += 2;
      continue;
    }
    if (arg.startsWith('--require=')) {
      preload.push(arg.slice(10));
      flags.push(arg);
      i += 1;
      continue;
    }
    // V8's own flags (only the `=` form; V8 reads them itself):
    // --stack-trace-limit=N sets Error.stackTraceLimit; --max-old-space-size=N
    // is accepted (the kernel sets a program's memory). A bad value is V8's
    // report, then Node's for the flags V8 then didn't take.
    if (arg === '--stack-trace-limit' || arg.startsWith('--stack-trace-limit=')) {
      if (!/^-?\d+$/.test(arg.slice(20))) {
        return { error: v8FlagError(argv0, [`Error: illegal value for flag ${arg} of type int`], arg), status: 9 };
      }
      flags.push(arg);
      i += 1;
      continue;
    }
    if (arg === '--max-old-space-size' || arg.startsWith('--max-old-space-size=')) {
      const value = arg.slice(21);
      const bounds = `Error: Value for flag ${arg} of type size_t is out of bounds [0-18446744073709551615]`;
      // A negative size: V8 says so and goes on (with its default).
      if (/^-\d+$/.test(value)) {
        v8Warnings.push(bounds, 'Try --help for options');
        flags.push(arg);
        i += 1;
        continue;
      }
      if (!/^\d+$/.test(value)) {
        // Linux's V8 (strtoull doesn't take the value): just "illegal value";
        // macOS's prints the out-of-bounds line before it.
        return { error: v8FlagError(argv0, [`Error: illegal value for flag ${arg} of type size_t`], arg), status: 9 };
      }
      flags.push(arg);
      i += 1;
      continue;
    }
    // --import X / --import=X: ES modules loaded before the entry (after -r).
    if (arg === '--import') {
      if (missingValue(args[i + 1])) return { error: `${argv0}: ${arg} requires an argument`, status: 9 };
      imports.push(args[i + 1]);
      flags.push(arg, args[i + 1]);
      i += 2;
      continue;
    }
    if (arg.startsWith('--import=')) {
      if (arg === '--import=') return { error: `${argv0}: ${arg} requires an argument`, status: 9 };
      imports.push(arg.slice(9));
      flags.push(arg);
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
      flags.push(arg);
      i += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg) || (arg.startsWith('--') && booleanToggle(arg.split('=')[0]))) {
      flags.push(arg);
      i += 1;
      continue;
    }
    const valued = VALUED_FLAGS.find((f) => arg === f || arg.startsWith(`${f}=`));
    if (valued) {
      if (arg === valued) {
        if (missingValue(args[i + 1])) return { error: `${argv0}: ${arg} requires an argument`, status: 9 };
        flags.push(arg, args[i + 1]);
        i += 2;
      } else {
        flags.push(arg);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('-')) {
      if (arg === '-c' || arg === '--check') {
        i += 1;
        continue;
      }
      return { error: `${argv0}: bad option: ${arg}`, status: 9 };
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

  if (evalCode !== undefined) {
    return {
      mode: 'eval',
      code: evalCode,
      print,
      processArgv: [argv0, ...userArgs],
      // In Node's order: the options as given, the code where it was.
      execArgv: [...flags],
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
      processArgv: [argv0, script, ...userArgs],
      execArgv: [...flags],
      preload,
      imports,
      v8Warnings,
    };
  }

  return {
    mode: 'empty',
    processArgv: stdinScript ? [argv0, '-', ...userArgs] : [argv0],
    execArgv: [...flags],
    interactive,
    preload,
    imports,
    v8Warnings,
    stdinScript,
  };
}
