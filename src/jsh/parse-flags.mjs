/**
 * `process.argv.parseFlags()`, ported from slicc's
 * `packages/webapp/src/kernel/realm/helpers/parse-flags.ts`.
 *
 * Skips argv[0] (the runtime) and argv[1] (the script).
 */
export function parseFlags(argv) {
  const positional = [];
  const flags = {};
  const passthrough = [];
  const set = (key, value) => {
    if (key in flags) {
      const prev = flags[key];
      if (Array.isArray(prev)) prev.push(String(value));
      else flags[key] = [String(prev), String(value)];
    } else {
      flags[key] = value;
    }
  };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        set(body.slice(0, eq), body.slice(eq + 1));
        i++;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        set(body, next);
        i += 2;
        continue;
      }
      set(body, true);
      i++;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) set(ch, true);
      i++;
      continue;
    }
    positional.push(arg);
    i++;
  }
  const subcommand =
    positional.length > 0 && /^[a-z][\w-]*$/i.test(positional[0]) ? positional[0] : null;
  return { positional, flags, subcommand, passthrough };
}

/** Define the non-enumerable `parseFlags()` on an argv array, in place. */
export function attachParseFlags(argv) {
  if (Object.prototype.hasOwnProperty.call(argv, 'parseFlags')) return argv;
  Object.defineProperty(argv, 'parseFlags', {
    value: () => parseFlags(argv),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return argv;
}
