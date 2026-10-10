/**
 * Format uncaught errors like Node's pretty-printer.
 * Do not invent node:internal frames — cert masks those on both sides.
 */

import { KERNEL_HINT } from './stack.mjs';

function sanitizeStack(stack) {
  if (!stack) return stack;
  return stack
    .split('\n')
    .filter((line) => !KERNEL_HINT.test(line))
    .filter((line) => !line.includes('at new Function'))
    .map((line) =>
      line
        .replace(/\bat Object\.eval \(([^)]+)\)/g, 'at Object.<anonymous> ($1)')
        .replace(/\bat eval \((\[eval\]:[^)]+)\)/g, 'at $1')
        .replace(/ \(node:internal\/slicc-jsh\)/g, '')
    )
    .join('\n');
}

function frameLocation(stack) {
  if (!stack) return null;
  const m =
    /at [^\n]*?(?:\[eval\]|(\/[^:\n\)]+)):(\d+):(\d+)/.exec(stack) ||
    /at (\[eval\]):(\d+):(\d+)/.exec(stack);
  if (!m) return null;
  const file = m[1] === undefined || m[0].includes('[eval]') ? '[eval]' : m[1];
  return { file, line: Number(m[2]), column: Number(m[3]) };
}

function snippetFor(ctx, loc, evalCode) {
  if (!loc) return null;
  let source;
  if (loc.file === '[eval]') source = evalCode;
  else {
    try {
      source = new TextDecoder().decode(ctx.sync.fs.readFile(loc.file));
    } catch {
      return null;
    }
  }
  if (source == null) return null;
  const display = source.replace(/^#![^\n]*\n/, '');
  const lines = display.split('\n');
  const n = loc.line >= 1 && loc.line <= lines.length ? loc.line : 1;
  const text = lines[n - 1];
  if (text === undefined) return null;
  let col = loc.column;
  const throwAt = text.search(/\bthrow\b/);
  const isAsyncLine = /\basync\b/.test(text);
  if (loc.file === '[eval]' && throwAt === 0) {
    col = 1;
  } else if (throwAt >= 0 && isAsyncLine && /\bthrow\s+new\b/.test(text)) {
    col = text.indexOf('new', throwAt) + 1;
  } else if (throwAt >= 0) {
    col = throwAt + 1;
  } else if (!(col >= 1)) {
    col = 1;
  }
  col = Math.min(Math.max(1, col), Math.max(1, text.length + 1));
  return { file: loc.file, lineNo: n, text, caret: `${' '.repeat(col - 1)}^` };
}

function assertionHeader(err) {
  const msg = err.message || '';
  if (err.name === 'AssertionError' || err.code === 'ERR_ASSERTION') {
    return `AssertionError [ERR_ASSERTION]: ${msg}`;
  }
  return null;
}

export function formatUncaughtError(err, { ctx, util, version, evalCode } = {}) {
  const trailer = `\nNode.js v${version}\n`;
  if (err instanceof Error && err._fsPretty) {
    let body = err._fsPretty;
    if (!body.includes('Node.js v')) body += trailer;
    return { body };
  }
  if (!(err instanceof Error)) {
    const shown = util.inspect(err);
    return {
      body:
        `\n[eval]:1\nthrow ${shown}\n^\n${shown}\n` +
        `(Use \`node --trace-uncaught ...\` to show where the exception was thrown)\n` +
        trailer,
    };
  }

  const rawStack = sanitizeStack(err.stack) || `${err.name}: ${err.message}`;
  let head = '';
  let first = rawStack;

  if (err.code === 'MODULE_NOT_FOUND') {
    // Throw-site header only (not synthetic `at node:internal/…` frames).
    head = `node:internal/modules/cjs/loader:1386\n  throw err;\n  ^\n\n`;
  } else if (err.code === 'ERR_ASSERTION' || err.name === 'AssertionError') {
    head = `node:assert:150\n  throw new AssertionError(obj);\n  ^\n\n`;
    const ah = assertionHeader(err);
    if (ah && !first.startsWith('AssertionError')) {
      const rest = first.split('\n').slice(1).join('\n');
      first = rest ? `${ah}\n${rest}` : ah;
    } else if (ah && first.startsWith('AssertionError:')) {
      first = first.replace(/^AssertionError:/, 'AssertionError [ERR_ASSERTION]:');
    }
  } else if (err.name === 'SyntaxError' && err._prettyStack) {
    const pretty = err._prettyStack;
    if (/\n\s*\^\n/.test(pretty)) {
      return { body: `${pretty}\n${trailer}` };
    }
    first = pretty.includes('SyntaxError:') ? pretty : rawStack;
  } else {
    const loc = frameLocation(rawStack);
    const snip = snippetFor(ctx, loc, evalCode);
    if (snip) head = `${snip.file}:${snip.lineNo}\n${snip.text}\n${snip.caret}\n\n`;
  }

  if (err.code === 'MODULE_NOT_FOUND' && err.requireStack?.[0]) {
    const rs = err.requireStack[0];
    first = `Error: ${err.message}\n    at Object.<anonymous> (${rs}:1:1)`;
  }

  // ALL own enumerable properties (plus common non-enumerable Node fields).
  let extras = '';
  const preferred =
    err.code === 'ERR_ASSERTION' || err.name === 'AssertionError'
      ? ['generatedMessage', 'code', 'actual', 'expected', 'operator', 'diff']
      : err.code === 'MODULE_NOT_FOUND'
        ? ['code', 'requireStack']
        : null;
  const discovered = [
    ...Object.keys(err),
    ...Object.getOwnPropertyNames(err).filter((k) => {
      if (k === 'message' || k === 'stack' || k === 'name') return false;
      const d = Object.getOwnPropertyDescriptor(err, k);
      return d && (d.enumerable || ['code', 'errno', 'syscall', 'path', 'requireStack', 'actual', 'expected', 'operator', 'generatedMessage', 'diff'].includes(k));
    }),
  ];
  const keys = preferred
    ? [...preferred.filter((k) => discovered.includes(k)), ...discovered.filter((k) => !preferred.includes(k))]
    : discovered;
  const showProps = keys.length > 0;
  if (showProps) {
    const fields = [];
    const seen = new Set();
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (key === 'message' || key === 'stack' || key === 'name') continue;
      if (key.startsWith('_')) continue;
      try {
        let inspected;
      if (key === 'requireStack' && Array.isArray(err[key])) {
        inspected =
          err[key].length === 0
            ? '[]'
            : `[\n    ${err[key].map((p) => util.inspect(p)).join(',\n    ')}\n  ]`;
      } else {
        inspected = util.inspect(err[key], { depth: 2, breakLength: 50 }).replace(/\n/g, '\n  ');
      }
      fields.push(`  ${key}: ${inspected}`);
      } catch {
        /* skip */
      }
    }
    if (fields.length) {
      const lines = first.split('\n');
      let lastIdx = lines.length - 1;
      while (lastIdx > 0 && lines[lastIdx].trim() === '') lastIdx--;
      lines[lastIdx] = `${lines[lastIdx]} {`;
      first = lines.join('\n');
      extras = `${fields.join(',\n')}\n}\n`;
    }
  }

  return { body: `${head}${first}\n${extras}${trailer}` };
}
