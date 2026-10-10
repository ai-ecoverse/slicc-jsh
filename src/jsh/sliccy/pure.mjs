/**
 * The pure `sliccy:` helpers: `color`, `cli`, `fmt`, `time` and `pool`,
 * ported from slicc's `packages/webapp/src/kernel/realm/helpers/`.
 * Same code in the kernel `jsh` and the host `jsh`.
 */

const ANSI = {
  reset: '\u001b[0m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  gray: '\u001b[90m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  dim: '\u001b[2m',
};

/**
 * Colour decision (decided 2026-10-10 on slicc-jsh#22): on when stdout is a
 * TTY. `FORCE_COLOR` (anything but '', '0' or 'false') forces it on, and
 * `FORCE_COLOR=0` off; otherwise a non-empty `NO_COLOR` turns it off.
 */
export function colorEnabled(env, stdoutIsTTY) {
  const force = env?.FORCE_COLOR;
  if (force !== undefined) return force !== '' && force !== '0' && force !== 'false';
  if (env?.NO_COLOR) return false;
  return !!stdoutIsTTY;
}

export function createColor(enabled) {
  const wrap = (code) => (s) => (enabled ? `${code}${s}${ANSI.reset}` : String(s));
  return Object.freeze({
    enabled,
    green: wrap(ANSI.green),
    red: wrap(ANSI.red),
    yellow: wrap(ANSI.yellow),
    gray: wrap(ANSI.gray),
    bold: wrap(ANSI.bold),
    cyan: wrap(ANSI.cyan),
    dim: wrap(ANSI.dim),
  });
}

export function createCli({ writeStdout, writeStderr, exit, color }) {
  const toLine = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.message;
    if (v === null || v === undefined) return String(v);
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };
  const prefixed = (paint, prefix, text, fallback) => {
    if (prefix === undefined) return `${paint(`${fallback}:`)} ${text}\n`;
    if (prefix === '') return `${paint(text)}\n`;
    return `${paint(`${prefix}:`)} ${text}\n`;
  };
  const prefixOf = (opts) =>
    typeof opts === 'object' && opts !== null && 'prefix' in opts ? opts.prefix : undefined;
  return Object.freeze({
    die(msg, opts) {
      const code = typeof opts === 'number' ? opts : (opts?.exitCode ?? 1);
      writeStderr(prefixed(color.red, prefixOf(opts), toLine(msg), 'Error'));
      exit(code);
      throw new Error('unreachable');
    },
    out(value) {
      if (typeof value === 'string') {
        writeStdout(value.endsWith('\n') ? value : `${value}\n`);
        return;
      }
      try {
        writeStdout(`${JSON.stringify(value, null, 2)}\n`);
      } catch {
        writeStdout(`${String(value)}\n`);
      }
    },
    warn(msg, opts) {
      writeStderr(prefixed(color.yellow, prefixOf(opts), toLine(msg), 'Warning'));
    },
    help(text) {
      writeStdout(text.endsWith('\n') ? text : `${text}\n`);
      exit(0);
      throw new Error('unreachable');
    },
  });
}

// --- fmt -------------------------------------------------------------------

const ANSI_RE = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');
const visibleLength = (s) => stripAnsi(s).length;
const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

function trunc(s, n) {
  const text = String(s ?? '');
  if (n <= 0) return '';
  if (visibleLength(text) <= n) return text;
  if (n <= 1) return text.slice(0, n);
  return `${stripAnsi(text).slice(0, n - 1)}…`;
}

function col(s, width) {
  const text = String(s ?? '');
  const vis = visibleLength(text);
  if (vis === width) return text;
  if (vis > width) return trunc(text, width);
  return text + ' '.repeat(width - vis);
}

function table(rows, widths) {
  if (!rows.length) return '';
  const colCount = Math.max(...rows.map((r) => r.length));
  const computed = [];
  for (let i = 0; i < colCount; i++) {
    if (widths && widths[i] !== undefined) {
      computed[i] = widths[i];
    } else {
      let max = 0;
      for (const r of rows) max = Math.max(max, visibleLength(i < r.length ? String(r[i] ?? '') : ''));
      computed[i] = max;
    }
  }
  return rows
    .map((r) =>
      computed
        .map((w, i) => col(i < r.length ? String(r[i] ?? '') : '', w))
        .join('  ')
        .replace(/\s+$/, '')
    )
    .join('\n');
}

function fmtDate(value, style = 'short') {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  if (style === 'iso') return d.toISOString();
  if (style === 'locale') return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(d);
  if (style === 'human') {
    const diff = Date.now() - d.getTime();
    const abs = Math.abs(diff);
    if (abs < 60_000) return diff >= 0 ? 'just now' : 'in a moment';
    const tense = (n, u) =>
      diff >= 0 ? `${n} ${u}${n === 1 ? '' : 's'} ago` : `in ${n} ${u}${n === 1 ? '' : 's'}`;
    if (abs < 3_600_000) return tense(Math.round(abs / 60_000), 'minute');
    if (abs < 86_400_000) return tense(Math.round(abs / 3_600_000), 'hour');
    if (abs < 2_629_800_000) return tense(Math.round(abs / 86_400_000), 'day');
    if (abs < 31_557_600_000) return tense(Math.round(abs / 2_629_800_000), 'month');
    return tense(Math.round(abs / 31_557_600_000), 'year');
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export const fmt = Object.freeze({ trunc, col, table, date: fmtDate });

// --- time ------------------------------------------------------------------

const DURATION_UNITS_MS = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  M: 2_629_800_000,
  y: 31_557_600_000,
};

function parseDuration(spec) {
  if (typeof spec === 'number' && Number.isFinite(spec)) return Math.trunc(spec);
  if (typeof spec !== 'string') throw new TypeError('time.parseDuration: spec must be string or number');
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h|d|w|M|y)?$/.exec(spec.trim());
  if (!m) throw new RangeError(`time.parseDuration: unrecognized spec "${spec}"`);
  return Math.trunc(Number(m[1]) * DURATION_UNITS_MS[m[2] ?? 'ms']);
}

export const time = Object.freeze({
  parseDuration,
  ago(spec, from = new Date()) {
    return new Date(from.getTime() - parseDuration(spec));
  },
  range(spec, from = new Date()) {
    const end = new Date(from.getTime());
    return { start: new Date(end.getTime() - parseDuration(spec)), end };
  },
  future(spec, from = new Date()) {
    const start = new Date(from.getTime());
    return { start, end: new Date(start.getTime() + parseDuration(spec)) };
  },
  gmailDate(spec, from = new Date()) {
    const d = new Date(from.getTime() - parseDuration(spec));
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  },
});

// --- pool ------------------------------------------------------------------

export async function pool(concurrency, items, fn) {
  const n = Math.max(1, Math.trunc(concurrency) || 1);
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = [];
  for (let w = 0; w < Math.min(n, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
