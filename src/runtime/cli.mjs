/**
 * Parse `node` argv the way Node 22 does for -e / -p / script.js.
 * `argv` is ctx.argv: [argv0, ...args].
 */
export function parseNodeArgv(argv) {
  const argv0 = argv[0] ?? 'node';
  const args = argv.slice(1);
  let evalCode;
  let print = false;
  let script;
  const userArgs = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') {
      userArgs.push(...args.slice(i + 1));
      break;
    }
    if (arg === '-e' || arg === '--eval') {
      i += 1;
      if (i >= args.length) {
        return { error: `${argv0}: ${arg} requires an argument`, status: 9 };
      }
      evalCode = args[i];
      i += 1;
      // Everything after the eval string is process.argv[1..] (not a script file).
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
    // Node: process.argv is [node, ...args after the eval string], no '-e' or code.
    return {
      mode: 'eval',
      code: evalCode,
      print,
      processArgv: [argv0, ...userArgs],
    };
  }

  if (script !== undefined) {
    return {
      mode: 'file',
      script,
      processArgv: [argv0, script, ...userArgs],
    };
  }

  // No script: Node starts the REPL. We exit 0 (PR1 behavior preserved for bare `node`).
  return {
    mode: 'empty',
    processArgv: [argv0],
  };
}
