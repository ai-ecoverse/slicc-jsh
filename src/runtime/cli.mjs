/**
 * Parse `node` argv the way Node 22 does for -e / -p / -v / -h / script.js.
 * `argv` is ctx.argv: [argv0, ...args].
 */
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
const VALUED_FLAGS = ['--disable-warning', '--redirect-warnings', '--input-type'];
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

export function parseNodeArgv(argv) {
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
      if (i >= args.length) {
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
      if (i + 1 >= args.length) return { error: `${argv0}: ${arg} requires an argument`, status: 9 };
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
      if (i + 1 >= args.length) return { error: `${argv0}: ${arg} requires an argument`, status: 9 };
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
    if (BOOLEAN_FLAGS.has(arg)) {
      flags.push(arg);
      i += 1;
      continue;
    }
    const valued = VALUED_FLAGS.find((f) => arg === f || arg.startsWith(`${f}=`));
    if (valued) {
      if (arg === valued) {
        if (i + 1 >= args.length) return { error: `${argv0}: ${arg} requires an argument`, status: 9 };
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
