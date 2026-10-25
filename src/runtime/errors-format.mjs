/**
 * Format uncaught errors like Node's pretty-printer.
 * Prefer util.inspect(err) for the props block (symbols, cause, AggregateError).
 */

import * as acorn from 'acorn';
import { KERNEL_HINT, errorSource, errorSourceCaret, functionSource, generatedLocation } from './stack.mjs';
import { kDecorated } from './builtins/vm.mjs';
import { sourceMapErrorSource } from './source-maps.mjs';

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
  const plain = /at [^\n]*?(?:\[(?:eval|stdin)\]|(\/[^:\n\)]+)):(\d+):(\d+)/.exec(stack);
  if (esm && (!plain || esm.index <= plain.index)) {
    // Its path: the URL less its query and fragment.
    let file = esm[1].slice('file://'.length).replace(/[?#].*$/, '');
    try {
      file = decodeURIComponent(file);
    } catch {
      /* keep */
    }
    return { file, url: esm[1], line: Number(esm[2]), column: Number(esm[3]), esm: true };
  }
  const m = /at [^\n]*?(?:\[(eval|stdin)\]|(\/[^:\n\)]+)):(\d+):(\d+)/.exec(stack);
  if (!m) return null;
  const file = m[1] === undefined ? m[2] : `[${m[1]}]`;
  return { file, line: Number(m[3]), column: Number(m[4]) };
}
const isEvalFile = (file) => file === '[eval]' || file === '[stdin]';

function sourceOf(ctx, file, evalCode) {
  if (isEvalFile(file) || file.endsWith('/[eval1]')) return evalCode;
  try {
    return new TextDecoder().decode(ctx.sync.fs.readFile(file));
  } catch {
    return null;
  }
}

const EVAL_FRAME = /^ {4}at [^(\n]*\((eval at [^\n]*), <anonymous>:(\d+):(\d+)\)$/;
const ORIGIN = /^eval at [^()]* \((.*)\)$/;
const ORIGIN_SITE = /^(\[eval\]|\[stdin\]|file:\/\/\/[^\s]*|\/[^\s]*):(\d+):(\d+)$/;

function urlPath(file) {
  if (!file.startsWith('file://')) return file;
  try {
    return decodeURIComponent(file.slice('file://'.length).replace(/[?#].*$/, ''));
  } catch {
    return file;
  }
}

function literalText(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}

function evalSource(outer, line, column) {
  let ast;
  try {
    ast = acorn.parse(outer, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
  } catch {
    try {
      ast = acorn.parse(outer, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    } catch {
      return undefined;
    }
  }
  const lines = outer.split('\n');
  if (line < 1 || line > lines.length) return undefined;
  const at = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1;
  let best;
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if ((node.type === 'CallExpression' || node.type === 'NewExpression') && node.arguments.length > 0) {
      const callee = node.callee.type === 'SequenceExpression' ? node.callee.expressions.at(-1) : node.callee;
      const name = callee.type === 'Identifier' ? callee.name : undefined;
      if ((name === 'eval' || name === 'Function') && at >= node.start && at <= node.arguments[0].start) {
        if (!best || node.start >= best.start) best = { node, name };
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(ast);
  if (!best) return undefined;
  const texts = best.node.arguments.map(literalText);
  if (texts.some((t) => t === undefined)) return undefined;
  if (best.name === 'eval') return texts[0];
  return `(function anonymous(${texts.slice(0, -1).join(',')}\n) {\n${texts.at(-1)}\n})`;
}

function originSource(ctx, origin, frames, evalCode, err) {
  const recorded = functionSource(err, origin);
  if (recorded !== undefined) return recorded;
  const parent = ORIGIN.exec(origin)?.[1];
  if (parent === undefined) return undefined;
  const site = ORIGIN_SITE.exec(parent);
  if (site) {
    const outer = sourceOf(ctx, urlPath(site[1]), evalCode);
    return typeof outer === 'string' ? evalSource(outer, Number(site[2]), Number(site[3])) : undefined;
  }
  const at = frames.find((f) => f[1] === parent);
  const outer = at ? originSource(ctx, parent, frames, evalCode, err) : undefined;
  return typeof outer === 'string' ? evalSource(outer, Number(at[2]), Number(at[3])) : undefined;
}

function evalLocation(ctx, stack, evalCode, err, v8) {
  const lines = stack.split('\n').filter((l) => l.startsWith('    at '));
  if (!lines[0]?.includes('(eval at ')) return undefined;
  const frames = lines.map((l) => EVAL_FRAME.exec(l)).filter(Boolean);
  const top = EVAL_FRAME.exec(lines[0]);
  let source = top ? originSource(ctx, top[1], frames, evalCode, err) : undefined;
  if (source === undefined && v8 && v8.lineNumber === Number(top?.[2])) source = `${'\n'.repeat(v8.lineNumber - 1)}${v8.sourceLine}`;
  if (source === undefined) return null;
  return { file: '<anonymous_script>', source, line: Number(top[2]), column: Number(top[3]) };
}

function snippetFor(ctx, loc, evalCode, fromPromise = false, v8 = undefined, esmEntry = false) {
  if (!loc) return null;
  let source;
  if (loc.source !== undefined) source = loc.source;
  else if (isEvalFile(loc.file) || loc.file.endsWith('/[eval1]')) source = evalCode;
  else {
    try {
      source = new TextDecoder().decode(ctx.sync.fs.readFile(loc.file));
    } catch {
      return null;
    }
  }
  if (source == null) return null;
  // A frame's lines are the file's own, its hashbang included.
  const display = source;
  const lines = display.split('\n');
  const n = loc.line >= 1 && loc.line <= lines.length ? loc.line : 1;
  const text = lines[n - 1];
  if (text === undefined) return null;
  const v8Caret = errorSourceCaret(v8, text, fromPromise || esmEntry);
  if (v8Caret !== undefined) return { file: loc.url ?? loc.file, lineNo: n, text, caret: v8Caret };
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
  } else if (isEvalFile(loc.file) && throwAt === 0) {
    col = 1;
  } else if (throwAt >= 0 && isAsyncLine && /\bthrow\s+new\b/.test(text)) {
    col = text.indexOf('new', throwAt) + 1;
  } else if (throwAt >= 0) {
    col = throwAt + 1;
  } else if (!(col >= 1)) {
    col = 1;
  }
  col = Math.min(Math.max(1, col), Math.max(1, text.length + 1));
  return { file: loc.url ?? loc.file, lineNo: n, text, caret: `${text.slice(0, col - 1).replace(/[^\t]/g, ' ')}^` };
}

/** With source maps, the original `file:line`, line and caret of `err`'s throw. */
function mappedErrorSource(ctx, err, evalCode, fromPromise, v8, esmEntry) {
  const gen = generatedLocation(err);
  if (!gen) return undefined;
  const esm = gen.file.startsWith('file://');
  let file = gen.file;
  if (esm) {
    try {
      file = decodeURIComponent(gen.file.slice('file://'.length).replace(/[?#].*$/, ''));
    } catch {
      return undefined;
    }
  }
  // The column V8's message has there: as for an unmapped report.
  const snip = snippetFor(ctx, { file, url: esm ? gen.file : undefined, line: gen.line, column: gen.column, esm }, evalCode, fromPromise, v8, esmEntry);
  if (!snip) return undefined;
  const source = sourceMapErrorSource(gen.file, gen.line, snip.caret.length - 1);
  // No original source to show: the code as run, as Node falls back to.
  return source ? `${source}\n` : `${snip.file}:${snip.lineNo}\n${snip.text}\n${snip.caret}\n\n`;
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

const MAIN_NOT_FOUND_FRAMES = [
  'Function._resolveFilename (node:internal/modules/cjs/loader:1383:15)',
  'defaultResolveImpl (node:internal/modules/cjs/loader:1025:19)',
  'resolveForCJSWithHooks (node:internal/modules/cjs/loader:1030:22)',
  'Function._load (node:internal/modules/cjs/loader:1192:37)',
  'TracingChannel.traceSync (node:diagnostics_channel:328:14)',
  'wrapModuleLoad (node:internal/modules/cjs/loader:237:24)',
  'Function.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:171:5)',
  'node:internal/main/run_main_module:36:49',
]
  .map((frame) => `    at ${frame}`)
  .join('\n');

function glueStackAndProps(stack, props) {
  const frames = stack.replace(/\n+$/, '');
  if (!props) return frames;
  return `${frames} ${finalizeProps(props)}`;
}

function attempt(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function throwSite(evalName, evalCode, shown) {
  let where = `${evalName}:1\nthrow ${shown}\n^`;
  if (typeof evalCode === 'string') {
    const lines = evalCode.split('\n');
    const n = lines.findIndex((l) => /\bthrow\b/.test(l));
    if (n >= 0) where = `${evalName}:${n + 1}\n${lines[n]}\n${' '.repeat(lines[n].search(/\bthrow\b/))}^`;
  }
  return where;
}

const MICROTASK_HEAD = '<anonymous_script>:0\n';
const TICKS_HEAD = 'node:internal/process/task_queues:105\n    runMicrotasks();\n    ^';
const microtaskHead = (evalName, firstTurn) => (firstTurn && evalName === '[stdin]' ? TICKS_HEAD : MICROTASK_HEAD);

function unreadableStack(err, { evalName, evalCode, fromScript, microtask, firstTurn, hint, trailer }) {
  const name = attempt(() => err.name);
  const message = attempt(() => err.message);
  const named = name !== undefined && message !== undefined;
  const text = (value) => attempt(() => String(value)) ?? '';
  const shown = named ? `${text(name)}: ${text(message)}` : text(err);
  const where = throwSite(evalName, evalCode, shown);
  if (!(err instanceof Error) && microtask) return { body: `\n${microtaskHead(evalName, firstTurn)}\n${shown}\n${hint}${trailer}` };
  if (!(err instanceof Error) && !fromScript) return { body: `\n${where}\n${shown}\n${hint}${trailer}` };
  return { body: named ? `${where}\n\n${shown}\n${hint}${trailer}` : `${shown}\n${hint}${trailer}` };
}

export function formatUncaughtError(err, { ctx, util, version, evalCode, evalName = '[eval]', fromPromise, esmEntry, fromScript, microtask, firstTurn } = {}) {
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
  const primitive = err === null || (typeof err !== 'object' && typeof err !== 'function');
  const shownThrown = () => (!primitive ? util.inspect(err) : typeof err === 'symbol' ? '' : String(err));
  const traceHint = `(Use \`node --trace-uncaught ...\` to show where the exception was thrown)\n`;
  const hint = primitive ? traceHint : '';
  if (!primitive) {
    let unreadable = false;
    try {
      void err.stack;
    } catch {
      unreadable = true;
    }
    if (unreadable) return unreadableStack(err, { evalName, evalCode, fromScript, microtask, firstTurn, hint: traceHint, trailer });
  }
  if (!(err instanceof Error) && microtask) {
    return { body: `\n${microtaskHead(evalName, firstTurn)}\n${shownThrown()}\n${hint}${trailer}` };
  }
  if (!(err instanceof Error) && esmEntry) {
    // Node: a primitive thrown by an ES module entry has no location of its own.
    const shown = shownThrown();
    return {
      body: `\nnode:internal/modules/run_main:123\n    triggerUncaughtException(\n    ^\n${shown}\n${hint}${trailer}`,
    };
  }
  if (!(err instanceof Error)) {
    // A thrown primitive has no stack: in -e code, point at its first
    // `throw` (V8 gives Node the exact spot); else Node's shape for line 1.
    const where = throwSite(evalName, evalCode, shownThrown());
    if (fromScript && !primitive) {
      const stack = attempt(() => err.stack);
      if (typeof stack !== 'string') return { body: `${where}\n\n${shownThrown()}\n${trailer}` };
      attempt(() => Reflect.set(err, 'stack', `${where}\n\n${stack}`));
      return { body: `${shownThrown()}\n${trailer}` };
    }
    return { body: `\n${where}\n${shownThrown()}\n${hint}${trailer}` };
  }

  const rawStack = sanitizeStack(err.stack) || `${err.name}: ${err.message}`;
  let head = '';

  // The ESM resolver's errors: Node's header (where its resolver throws them);
  // the frames are Node's own, so none here; then the props block.
  if (
    (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'ERR_UNSUPPORTED_DIR_IMPORT') &&
    / imported from /.test(String(err.message)) &&
    !/\n {4}at /.test(rawStack)
  ) {
    const props = [`  code: '${err.code}'`];
    if (err.url !== undefined) props.push(`  url: '${err.url}'`);
    const head =
      err.code === 'ERR_MODULE_NOT_FOUND'
        ? 'node:internal/modules/esm/resolve:274\n    throw new ERR_MODULE_NOT_FOUND(\n          ^\n\n'
        : 'node:internal/modules/esm/resolve:262\n    throw new ERR_UNSUPPORTED_DIR_IMPORT(path, basePath, String(resolved));\n          ^\n\n';
    return {
      body:
        head +
        `${err.name} [${err.code}]: ${err.message} {\n${props.join(',\n')}\n}\n${trailer}`,
    };
  }

  if (err.code === 'MODULE_NOT_FOUND') {
    head = `node:internal/modules/cjs/loader:1386\n  throw err;\n  ^\n\n`;
    const rs = err.requireStack?.[0];
    // The requiring file's frame (internal/preload's are Node's own); a
    // missing entry's are Node 22.22's, its loader finding the main.
    const requirerLine = rs?.startsWith('/') ? `    at Object.<anonymous> (${rs}:1:1)` : '';
    const stackLine = err.mainEntry ? MAIN_NOT_FOUND_FRAMES : requirerLine;
    // Node's inspect of the error, its defaults: a require stack that fits
    // on a line is one (`[ '/x.js' ]`).
    const inspected = sanitizeInspected(util.inspect(err, { depth: 10 }));
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

  const v8 = errorSource(err);
  const evalLoc = evalLocation(ctx, rawStack, evalCode, err, v8);
  const loc = evalLoc === undefined ? frameLocation(rawStack) : evalLoc;
  const top = rawStack.split('\n').find((l) => l.startsWith('    at '));
  const atTop = evalLoc !== undefined || (loc && top?.includes(`:${loc.line}:${loc.column}`));
  const snip = snippetFor(ctx, loc, evalCode, fromPromise, atTop ? v8 : undefined, esmEntry);
  if (snip) head = `${snip.file}:${snip.lineNo}\n${snip.text}\n${snip.caret}\n\n`;
  // Source maps: the position in the code as run, mapped (Node's GetErrorSource).
  const mapped = mappedErrorSource(ctx, err, evalCode, fromPromise, v8, esmEntry);
  if (mapped) head = mapped;
  if (attempt(() => err[kDecorated]) === true) head = '';

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

export function formatUnhandledRejection(reason, { ctx, util, version, evalCode, evalName } = {}) {
  // Node: Error rejections print like uncaught errors (reject-site snippet).
  if (reason instanceof Error) {
    return formatUncaughtError(reason, { ctx, util, version, evalCode, evalName, fromPromise: true });
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
