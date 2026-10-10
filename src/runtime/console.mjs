/** Node-like console writing through process.stdout / process.stderr sinks. */

function formatArg(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Uint8Array) {
    // Match Node's Buffer inspect lightly for small buffers in goldens.
    if (typeof value.toString === 'function' && value.constructor?.name === 'Buffer') {
      return value.toString();
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatLine(parts) {
  return `${parts.map(formatArg).join(' ')}\n`;
}

function labelOf(label) {
  return label === undefined ? 'default' : String(label);
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function createConsole(writeStdout, writeStderr) {
  const counts = new Map();
  const times = new Map();
  const group = { depth: 0 };

  const write = (sink, parts) => {
    const line = formatLine(parts);
    sink(group.depth > 0 ? `${'  '.repeat(group.depth)}${line}` : line);
  };

  const log = (...parts) => write(writeStdout, parts);
  const error = (...parts) => write(writeStderr, parts);

  return {
    log,
    info: log,
    debug: log,
    dirxml: log,
    table: log,
    warn: error,
    error,
    dir: (obj) => log(obj),
    clear: () => undefined,
    group: (...parts) => {
      if (parts.length) log(...parts);
      group.depth += 1;
    },
    groupCollapsed: (...parts) => {
      if (parts.length) log(...parts);
      group.depth += 1;
    },
    groupEnd: () => {
      if (group.depth > 0) group.depth -= 1;
    },
    assert: (condition, ...args) => {
      if (condition) return;
      if (args.length === 0) error('Assertion failed');
      else error(`Assertion failed: ${formatArg(args[0])}`, ...args.slice(1));
    },
    time: (label) => {
      const key = labelOf(label);
      if (times.has(key)) {
        error(`Label '${key}' already exists for console.time()`);
        return;
      }
      times.set(key, nowMs());
    },
    timeEnd: (label) => {
      const key = labelOf(label);
      const start = times.get(key);
      if (start === undefined) {
        error(`No such label '${key}' for console.timeEnd()`);
        return;
      }
      times.delete(key);
      log(`${key}: ${(nowMs() - start).toFixed(3)}ms`);
    },
    count: (label) => {
      const key = labelOf(label);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      log(`${key}: ${next}`);
    },
    countReset: (label) => {
      const key = labelOf(label);
      if (!counts.has(key)) {
        error(`Count for '${key}' does not exist`);
        return;
      }
      counts.set(key, 0);
    },
  };
}
