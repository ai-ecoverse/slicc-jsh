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
]);
const VALUED_FLAGS = ['--disable-warning', '--redirect-warnings'];

export function parseNodeArgv(argv) {
  const argv0 = argv[0] ?? 'node';
  const args = argv.slice(1);
  let evalCode;
  let print = false;
  let script;
  const userArgs = [];
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
      i += 1;
      userArgs.push(...args.slice(i));
      break;
    }
    if (arg === '-p' || arg === '--print') {
      print = true;
      i += 1;
      if (i >= args.length) {
        return { error: `${argv0}: ${arg} requires an argument`, status: 9 };
      }
      evalCode = args[i];
      i += 1;
      userArgs.push(...args.slice(i));
      break;
    }
    if (arg.startsWith('-e') && arg.length > 2) {
      evalCode = arg.slice(2);
      i += 1;
      userArgs.push(...args.slice(i));
      break;
    }
    if (arg.startsWith('-p') && arg.length > 2) {
      print = true;
      evalCode = arg.slice(2);
      i += 1;
      userArgs.push(...args.slice(i));
      break;
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
    script = arg;
    userArgs.push(...args.slice(i + 1));
    break;
  }

  if (evalCode !== undefined) {
    const flag = print ? '-p' : '-e';
    return {
      mode: 'eval',
      code: evalCode,
      print,
      processArgv: [argv0, ...userArgs],
      execArgv: [...flags, flag, evalCode],
    };
  }

  if (script !== undefined) {
    return {
      mode: 'file',
      script,
      processArgv: [argv0, script, ...userArgs],
      execArgv: [...flags],
    };
  }

  return {
    mode: 'empty',
    processArgv: [argv0],
    execArgv: [...flags],
  };
}
