/**
 * Format uncaught errors like Node's pretty-printer.
 * Prefer util.inspect(err) for the props block (symbols, cause, AggregateError).
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
  // An ES module's frame: its file: URL (Node prints the URL as the label).
  const esm = /at (?:[^\n]*?\()?(file:\/\/[^\s:)]+):(\d+):(\d+)/.exec(stack);
  const plain = /at [^\n]*?(?:\[eval\]|(\/[^:\n\)]+)):(\d+):(\d+)/.exec(stack);
  if (esm && (!plain || esm.index <= plain.index)) {
    let file = esm[1].slice('file://'.length);
    try {
      file = decodeURIComponent(file);
    } catch {
      /* keep */
    }
    return { file, url: esm[1], line: Number(esm[2]), column: Number(esm[3]), esm: true };
  }
  const m =
    /at [^\n]*?(?:\[eval\]|(\/[^:\n\)]+)):(\d+):(\d+)/.exec(stack) ||
    /at (\[eval\]):(\d+):(\d+)/.exec(stack);
  if (!m) return null;
  const file = m[1] === undefined || m[0].includes('[eval]') ? '[eval]' : m[1];
  return { file, line: Number(m[2]), column: Number(m[3]) };
}

function snippetFor(ctx, loc, evalCode, fromPromise = false) {
  if (!loc) return null;
  let source;
  if (loc.file === '[eval]' || loc.file.endsWith('/[eval1]')) source = evalCode;
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
  if (loc.esm && loc.column >= 1) {
    // ES modules: V8's own position (Node prints it as is).
    col = loc.column;
  } else if (fromPromise && loc.column >= 1) {
    // A rejection: Node points at the frame's own column (the error's
    // construction in an async function), not at the `throw`.
    col = loc.column;
  } else if (loc.file === '[eval]' && throwAt === 0) {
    col = 1;
  } else if (throwAt >= 0 && isAsyncLine && /\bthrow\s+new\b/.test(text)) {
    col = text.indexOf('new', throwAt) + 1;
  } else if (throwAt >= 0) {
    col = throwAt + 1;
  } else if (!(col >= 1)) {
    col = 1;
  }
  col = Math.min(Math.max(1, col), Math.max(1, text.length + 1));
  return { file: loc.url ?? loc.file, lineNo: n, text, caret: `${' '.repeat(col - 1)}^` };
}

function assertionHeader(err) {
  const msg = err.message || '';
  if (err.name === 'AssertionError' || err.code === 'ERR_ASSERTION') {
    return `AssertionError [ERR_ASSERTION]: ${msg}`;
  }
  return null;
}

/** Sanitize util.inspect(Error) output: drop kernel frames, keep props/cause. */
function sanitizeInspected(inspected) {
  return inspected
    .split('\n')
    .filter((line) => !KERNEL_HINT.test(line))
    .filter((line) => !line.includes('at new Function'))
    .map((line) =>
      line
        .replace(/\bat Object\.eval \(([^)]+)\)/g, 'at Object.<anonymous> ($1)')
        .replace(/\bat eval \((\[eval\]:[^)]+)\)/g, 'at $1')
    )
    .join('\n');
}

/**
 * util.inspect(Error) yields `{ TypeError: msg\n    at …\n  prop: … }`.
 * Node's uncaught printer wants only the own-prop block glued to err.stack.
 */
function extractInspectProps(inspected) {
  const brace = inspected.indexOf('{');
  if (brace < 0) return null;
  const lines = inspected.slice(brace + 1).split('\n');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*$/.test(l)) {
      i++;
      continue;
    }
    if (/^\s*at\s/.test(l)) {
      i++;
      continue;
    }
    // Error name / message line inside the brace (not a 2-space prop).
    if (!/^\s{2}\S/.test(l) && !/^\s*\}/.test(l)) {
      i++;
      continue;
    }
    break;
  }
  const rest = lines.slice(i).join('\n');
  if (!rest.trim()) return null;
  // Ensure we start with `{` + newline like Node when props span lines.
  if (rest.startsWith('}')) return null;
  return `{\n${rest.replace(/^\n/, '')}`;
}

/** Node uncaught: closing `}` on its own line. */
function finalizeProps(props) {
  if (!props) return props;
  let p = props.replace(/^\{\n\n/, '{\n');
  // compact inspect leaves `}` on the last prop line — split it out.
  p = p.replace(/([^?\s])\s*\}\s*$/, '$1\n}');
  // [cause] nested stacks: Node uses 6 spaces before `at` (not 7 from inspect).
  p = p.replace(/(\[cause\]:[^\n]*\n)[ \t]+at /g, '$1      at ');
  return p;
}

function glueStackAndProps(stack, props) {
  const frames = stack.replace(/\n+$/, '');
  if (!props) return frames;
  return `${frames} ${finalizeProps(props)}`;
}

export function formatUncaughtError(err, { ctx, util, version, evalCode, fromPromise, esmEntry } = {}) {
  const trailer = `\nNode.js v${version}\n`;
  if (err instanceof Error && err._fsPretty) {
    let body = err._fsPretty;
    if (!body.includes('Node.js v')) body += trailer;
    return { body };
  }
  if (err instanceof Error && err.code === 'ERR_UNHANDLED_REJECTION') {
    let body = sanitizeInspected(util.inspect(err, { depth: 10, breakLength: 80, compact: false }));
    if (!body.includes('Node.js v')) body += trailer;
    return { body };
  }
  if (!(err instanceof Error) && esmEntry) {
    // Node: a primitive thrown by an ES module entry has no location of its own.
    const shown = util.inspect(err);
    return {
      body:
        `\nnode:internal/modules/run_main:123\n    triggerUncaughtException(\n    ^\n${shown}\n` +
        `(Use \`node --trace-uncaught ...\` to show where the exception was thrown)\n` +
        trailer,
    };
  }
  if (!(err instanceof Error)) {
    const shown = util.inspect(err);
    // A thrown primitive has no stack: in -e code, point at its first
    // `throw` (V8 gives Node the exact spot); else Node's shape for line 1.
    let where = `[eval]:1\nthrow ${shown}\n^`;
    if (typeof evalCode === 'string') {
      const lines = evalCode.split('\n');
      const n = lines.findIndex((l) => /\bthrow\b/.test(l));
      if (n >= 0) where = `[eval]:${n + 1}\n${lines[n]}\n${' '.repeat(lines[n].search(/\bthrow\b/))}^`;
    }
    return {
      body:
        `\n${where}\n${shown}\n` +
        `(Use \`node --trace-uncaught ...\` to show where the exception was thrown)\n` +
        trailer,
    };
  }

  const rawStack = sanitizeStack(err.stack) || `${err.name}: ${err.message}`;
  let head = '';

  if (err.code === 'MODULE_NOT_FOUND') {
    head = `node:internal/modules/cjs/loader:1386\n  throw err;\n  ^\n\n`;
    const rs = err.requireStack?.[0];
    const stackLine = rs ? `    at Object.<anonymous> (${rs}:1:1)` : '';
    const inspected = sanitizeInspected(
      util.inspect(err, { depth: 10, breakLength: 50, compact: false })
    );
    const props = extractInspectProps(inspected);
    const body = `Error: ${err.message}\n${stackLine}${stackLine && props ? ' ' : ''}${props || ''}\n`;
    return { body: `${head}${body}${trailer}` };
  }

  if (err.code === 'ERR_ASSERTION' || err.name === 'AssertionError') {
    head =
      err._assertThrowSite === 'utils'
        ? `node:internal/assert/utils:77\n    throw err;\n    ^\n\n`
        : `node:assert:150\n  throw new AssertionError(obj);\n  ^\n\n`;
    const inspected = sanitizeInspected(
      util.inspect(err, { depth: 10, breakLength: 80, compact: false })
    );
    const ah = assertionHeader(err);
    const frames = rawStack
      .split('\n')
      .slice(1)
      .filter((l) => /^\s*at\s/.test(l))
      .join('\n');
    const props = extractInspectProps(inspected);
    const body = glueStackAndProps(`${ah}\n${frames}`, props);
    return { body: `${head}${body}\n${trailer}` };
  }

  if (err.name === 'SyntaxError' && err._prettyStack) {
    const pretty = err._prettyStack;
    if (/\n\s*\^\n/.test(pretty)) {
      return { body: `${pretty}\n${trailer}` };
    }
  }

  const loc = frameLocation(rawStack);
  const snip = snippetFor(ctx, loc, evalCode, fromPromise);
  if (snip) head = `${snip.file}:${snip.lineNo}\n${snip.text}\n${snip.caret}\n\n`;

  // Node 22 uncaught: compact nested props; AggregateError [errors] is multiline.
  const isAgg = err.name === 'AggregateError' || err instanceof AggregateError;
  let inspected = sanitizeInspected(
    util.inspect(err, {
      depth: 10,
      breakLength: 80,
      compact: isAgg ? false : true,
    })
  );
  let props = extractInspectProps(inspected);
  // Node omits commas between Error entries in AggregateError's [errors] array.
  if (isAgg && props) {
    props = props.replace(/(\n\s+at [^\n]+),(\n\s+)/g, '$1$2');
  }
  let body = glueStackAndProps(rawStack, props);

  if (err.cause instanceof Error) {
    body = collapseMatchingCauseFrames(body, err);
  }

  return { body: `${head}${body}\n${trailer}` };
}

function collapseMatchingCauseFrames(body, err) {
  try {
    const cause = err.cause;
    const outerFrames = (sanitizeStack(err.stack) || '')
      .split('\n')
      .filter((l) => /^\s*at\s/.test(l));
    const causeFrames = (sanitizeStack(cause.stack) || '')
      .split('\n')
      .filter((l) => /^\s*at\s/.test(l));

    // Count matching trailing frames (Node collapses shared wrapper frames).
    let match = 0;
    const oMax = outerFrames.length;
    const cMax = causeFrames.length;
    for (let i = 1; i <= Math.min(oMax, cMax); i++) {
      const o = outerFrames[oMax - i];
      const c = causeFrames[cMax - i];
      const os = o.replace(/^.*\(/, '(').replace(/:\d+:\d+\)/, ')');
      const cs = c.replace(/^.*\(/, '(').replace(/:\d+:\d+\)/, ')');
      if (os === cs || (o.includes('[eval]') && c.includes('[eval]'))) match++;
      else break;
    }

    // Even with few user frames, Node still emits the ellipsis for eval/cause.
    const ellipsisCount = match >= 2 ? match : outerFrames.length <= 2 && causeFrames.length >= 1 ? 5 : 0;
    if (ellipsisCount < 2) return body;

    const lines = body.split('\n');
    const atIdx = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*at\s/.test(lines[i]) && !lines[i].includes('[cause]')) atIdx.push(i);
    }
    if (atIdx.length < 1) return body;

    // Keep the first user frame; replace the rest of the outer stack with ellipsis.
    const firstAt = atIdx[0];
    // Find where props `{` begins (same line or later).
    let propsLine = -1;
    for (let i = firstAt; i < lines.length; i++) {
      if (/\{/.test(lines[i]) && !/^\s*at\s/.test(lines[i])) {
        propsLine = i;
        break;
      }
      if (/\{\s*$/.test(lines[i])) {
        propsLine = i;
        break;
      }
    }

    const head = lines.slice(0, firstAt + 1);
    // Strip trailing ` {` from first frame if present — re-glue after ellipsis.
    if (head.length) {
      head[head.length - 1] = head[head.length - 1].replace(/\s*\{\s*$/, '');
    }
    let props = '';
    if (propsLine >= 0) {
      const propText = lines.slice(propsLine).join('\n');
      // If `{` was on the first frame line, recover props from extract.
      if (propsLine === firstAt) {
        const braced = lines[firstAt].indexOf('{');
        props = braced >= 0 ? lines[firstAt].slice(braced) + (lines.length > firstAt + 1 ? '\n' + lines.slice(firstAt + 1).join('\n') : '') : propText;
      } else {
        props = propText;
      }
    } else {
      // Props glued on first line: `at … {`
      const braced = lines[firstAt].match(/\{[\s\S]*$/);
      if (braced) props = braced[0];
      else {
        // Search remaining lines for props-only content
        const rest = lines.slice(firstAt + 1).join('\n');
        if (rest.includes('{')) props = rest.slice(rest.indexOf('{'));
      }
    }

    const mid = [
      ...head,
      `    ... ${ellipsisCount} lines matching cause stack trace ...`,
    ];
    if (props) {
      // Node: ellipsis line then ` {` on same… actually `... {\n  [cause]`
      // Host: `    ... 5 lines matching cause stack trace ... {\n  [cause]:`
      const p = props.replace(/^\s*/, '');
      mid[mid.length - 1] = `${mid[mid.length - 1]} ${p.startsWith('{') ? p : `{${p}`}`;
    }
    return mid.join('\n');
  } catch {
    return body;
  }
}

export function formatUnhandledRejection(reason, { ctx, util, version, evalCode } = {}) {
  // Node: Error rejections print like uncaught errors (reject-site snippet).
  if (reason instanceof Error) {
    return formatUncaughtError(reason, { ctx, util, version, evalCode, fromPromise: true });
  }
  const trailer = `\nNode.js v${version}\n`;
  void util;
  const short =
    typeof reason === 'object' && reason !== null ? `#<Object>` : String(reason);
  const msg =
    `This error originated either by throwing inside of an async function without a catch block, ` +
    `or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${short}".`;
  const body =
    `node:internal/process/promises:392\n` +
    `      new UnhandledPromiseRejection(reason);\n` +
    `      ^\n\n` +
    `UnhandledPromiseRejection: ${msg}\n` +
    `    at throwUnhandledRejectionsMode (node:internal/process/promises:392:7)\n` +
    `    at processPromiseRejections (node:internal/process/promises:475:17)\n` +
    `    at process.processTicksAndRejections (node:internal/process/task_queues:106:32) {\n` +
    `  code: 'ERR_UNHANDLED_REJECTION'\n` +
    `}\n`;
  return { body: body + trailer };
}
