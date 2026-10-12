/** Node-like console using util.format / util.inspect. */

function labelOf(label) {
  return label === undefined ? 'default' : String(label);
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// Node's console formats with util.formatWithOptions, colored or not.
function formatArgs(util, args, colors = false) {
  return util.formatWithOptions(colors ? { colors: true } : {}, ...args);
}

function tableCell(value, util) {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return util.inspect(value, { colors: false });
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return util.inspect(value, { colors: false, depth: 0 });
}

function renderTable(tabularData, util) {
  if (!Array.isArray(tabularData) || tabularData.length === 0) {
    return util.inspect(tabularData, { depth: 2 });
  }
  const primitive = tabularData.every((r) => r === null || typeof r !== 'object');
  let headers;
  let rows;
  if (primitive) {
    headers = ['(index)', 'Values'];
    rows = tabularData.map((r, i) => [String(i), tableCell(r, util)]);
  } else {
    const keys = [
      ...new Set(tabularData.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : []))),
    ];
    headers = ['(index)', ...keys];
    rows = tabularData.map((r, i) => {
      const cells = keys.map((k) =>
        r && typeof r === 'object' && k in r ? tableCell(r[k], util) : ''
      );
      return [String(i), ...cells];
    });
  }
  const widths = headers.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => (r[col] ?? '').length))
  );
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
  const line = (left, mid, right, fill) =>
    left + widths.map((w) => fill.repeat(w + 2)).join(mid) + right;
  const rowLine = (cells) => `│ ${cells.map((c, i) => pad(c, widths[i])).join(' │ ')} │`;
  return [
    line('┌', '┬', '┐', '─'),
    rowLine(headers),
    line('├', '┼', '┤', '─'),
    ...rows.map(rowLine),
    line('└', '┴', '┘', '─'),
  ].join('\n');
}

/**
 * @param {(fd: 1 | 2) => boolean} [colorFor] Node's shouldColorize for that
 *   stream (FORCE_COLOR, or a terminal with more than 2 bits of color)
 */
export function createConsole(writeStdout, writeStderr, util, colorFor = () => false) {
  const counts = new Map();
  const times = new Map();
  const group = { depth: 0 };

  const write = (sink, args) => {
    const body = formatArgs(util, args, colorFor(sink === writeStdout ? 1 : 2));
    const line = `${body}\n`;
    sink(group.depth > 0 ? `${'  '.repeat(group.depth)}${line}` : line);
  };

  const log = (...args) => write(writeStdout, args);
  const error = (...args) => write(writeStderr, args);

  return {
    log,
    info: log,
    debug: log,
    dirxml: log,
    warn: error,
    error,
    dir(obj, options) {
      const colors = colorFor(1) ? { colors: true } : {};
      writeStdout(`${util.inspect(obj, { customInspect: false, ...colors, ...options })}\n`);
    },
    trace: function trace(...args) {
      const err = { name: 'Trace', message: formatArgs(util, args, colorFor(2)) };
      Error.captureStackTrace(err, trace);
      error(err.stack);
    },
    table(tabularData) {
      writeStdout(`${renderTable(tabularData, util)}\n`);
    },
    clear: () => undefined,
    group: (...args) => {
      if (args.length) log(...args);
      group.depth += 1;
    },
    groupCollapsed: (...args) => {
      if (args.length) log(...args);
      group.depth += 1;
    },
    groupEnd: () => {
      if (group.depth > 0) group.depth -= 1;
    },
    assert: (condition, ...args) => {
      if (condition) return;
      if (args.length === 0) error('Assertion failed');
      else if (typeof args[0] === 'string') error(`Assertion failed: ${args[0]}`, ...args.slice(1));
      else error('Assertion failed', ...args);
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
