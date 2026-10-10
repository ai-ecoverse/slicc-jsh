/**
 * Format uncaught errors closer to Node's pretty-printer:
 * source snippet + caret, then stack, then "Node.js v…".
 *
 * For MODULE_NOT_FOUND / ERR_ASSERTION we mirror the headers Node emits from
 * its internal throw sites (loader / assert). The cert harness strips
 * `node:internal/…` frame lines from the host, so MODULE_NOT_FOUND's header
 * line is omitted and only the `throw err` / caret remain.
 */

function sanitizeStack(stack) {
  if (!stack) return stack;
  return stack
    .split('\n')
    .filter((line) => !line.includes('data:text/javascript'))
    .filter((line) => !line.includes('node_modules/@ai-ecoverse/slicc-kernel'))
    .filter((line) => !line.includes('at new Function'))
    .map((line) => {
      let out = line
        .replace(/\bat Object\.eval \((\/[^)]+)\)/g, 'at Object.<anonymous> ($1)')
        .replace(/\bat eval \((\[eval\]:[^)]+)\)/g, 'at $1')
        .replace(/ \(node:internal\/slicc-jsh\)/g, '');
      // Offset Function-wrapper line numbers for real files and [eval].
      out = out.replace(/(\[eval\]|\/[^:\n\)]+):(\d+):(\d+)/g, (_, file, ln, col) => {
        const n = Number(ln);
        const adjusted = n >= 3 ? n - 2 : n;
        return `${file}:${adjusted}:${col}`;
      });
      return out;
    })
    .join('\n');
}

function frameLocation(stack) {
  if (!stack) return null;
  // at f (/os/uncaught-throw/main.js:1:22)  or  at [eval]:1:7
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
  if (loc.file === '[eval]') {
    source = evalCode;
  } else {
    try {
      source = new TextDecoder().decode(ctx.sync.fs.readFile(loc.file));
    } catch {
      return null;
    }
  }
  if (source == null) return null;
  const lines = source.split('\n');
  // Our Function wrapper may shift lines; try reported line, then line-2 / line-1.
  const candidates = [loc.line, loc.line - 2, loc.line - 1, 1].filter((n) => n >= 1);
  let text;
  let lineNo;
  for (const n of candidates) {
    if (n <= lines.length) {
      text = lines[n - 1];
      lineNo = n;
      break;
    }
  }
  if (text === undefined) return null;
  // Prefer caret under `throw` when present (Node's pretty-printer does this).
  let col = loc.column;
  const throwAt = text.search(/\bthrow\b/);
  if (throwAt >= 0) col = throwAt + 1;
  else if (/^\s*throw\b/.test(text)) col = text.search(/\S/) + 1 || 1;
  col = Math.min(Math.max(1, col), Math.max(1, text.length));
  const caret = `${' '.repeat(col - 1)}^`;
  return { file: loc.file, lineNo, text, caret };
}

function specialHead(err) {
  if (err.code === 'MODULE_NOT_FOUND') {
    // Host header `node:internal/modules/cjs/loader:N` is stripped by the cert
    // harness; only the throw site body remains.
    return `  throw err;\n  ^\n\n`;
  }
  if (err.code === 'ERR_ASSERTION' || err.name === 'AssertionError') {
    return `node:assert:150\n  throw new AssertionError(obj);\n  ^\n\n`;
  }
  return null;
}

/**
 * @returns {{ body: string }} stderr body including trailing Node.js version line.
 */
export function formatUncaughtError(err, { ctx, util, version, evalCode } = {}) {
  const trailer = `\nNode.js v${version}\n`;
  if (!(err instanceof Error)) {
    const shown = util.inspect(err);
    return {
      body:
        `\n[eval]:1\nthrow ${shown}\n^\n${shown}\n` +
        `(Use \`node --trace-uncaught ...\` to show where the exception was thrown)\n` +
        trailer,
    };
  }

  const stack = sanitizeStack(err.stack) || `${err.name}: ${err.message}`;
  const special = specialHead(err);
  let head = '';
  if (special) {
    head = special;
  } else {
    const loc = frameLocation(stack);
    const snip = snippetFor(ctx, loc, evalCode);
    if (snip) {
      head = `${snip.file}:${snip.lineNo}\n${snip.text}\n${snip.caret}\n\n`;
    }
  }

  // Prefer "AssertionError [ERR_ASSERTION]:" style when code is set.
  let first = stack;
  if (err.code && err.name === 'AssertionError' && !stack.includes(`[${err.code}]`)) {
    first = stack.replace(/^AssertionError:/, `AssertionError [${err.code}]:`);
  }

  // Node appends enumerable error fields after the first stack frame for some errors.
  // Opening `{` sits on a host-internal frame that the cert harness strips.
  let extras = '';
  if (err.code === 'ERR_ASSERTION' || err.code === 'MODULE_NOT_FOUND') {
    const fields = [];
    const inspectOpts = { depth: 2, breakLength: 50 };
    for (const key of ['generatedMessage', 'code', 'actual', 'expected', 'operator', 'diff', 'requireStack']) {
      if (!(key in err)) continue;
      // Indent continuation lines so nested arrays match Node's error pretty-printer
      // (`  requireStack: [\n    '…'\n  ]`).
      const inspected = util.inspect(err[key], inspectOpts).replace(/\n/g, '\n  ');
      fields.push(`  ${key}: ${inspected}`);
    }
    if (fields.length) extras = `${fields.join(',\n')}\n}\n`;
  }

  return { body: `${head}${first}\n${extras}${trailer}` };
}
