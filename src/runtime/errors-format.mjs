/**
 * Format uncaught errors like Node's pretty-printer.
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
    // Node points at column 1 for top-level `throw …` in -e.
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

/**
 * Synthesize Node-like internal frames for MODULE_NOT_FOUND / assert so host
 * stacks (with node:internal/…) match without depending on our thin stacks.
 */
function nodeLikeStack(err, userStack) {
  if (err.code === 'MODULE_NOT_FOUND') {
    const requireStack = err.requireStack || [];
    const userFrame =
      userStack
        .split('\n')
        .find((l) => /^\s*at\s/.test(l) && (l.includes('Object.<anonymous>') || /\(\/[^)]+:\d+:\d+\)/.test(l))) ||
      (requireStack[0] ? `    at Object.<anonymous> (${requireStack[0]}:1:1)` : '    at Object.<anonymous>');
    return (
      `Error: ${err.message}\n` +
      `    at Function._resolveFilename (node:internal/modules/cjs/loader:1383:15)\n` +
      `    at defaultResolveImpl (node:internal/modules/cjs/loader:1025:19)\n` +
      `    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1030:22)\n` +
      `    at Function._load (node:internal/modules/cjs/loader:1192:37)\n` +
      `    at TracingChannel.traceSync (node:diagnostics_channel:328:14)\n` +
      `    at wrapModuleLoad (node:internal/modules/cjs/loader:237:24)\n` +
      `    at Module.require (node:internal/modules/cjs/loader:1463:12)\n` +
      `    at require (node:internal/modules/helpers:147:16)\n` +
      `${userFrame}\n` +
      `    at Module._compile (node:internal/modules/cjs/loader:1706:14)`
    );
  }
  if (err.code === 'ERR_ASSERTION' || err.name === 'AssertionError') {
    const userFrame =
      userStack.split('\n').find((l) => /^\s*at\s/.test(l) && (l.includes('[eval]') || l.includes('/os/'))) ||
      '    at [eval]:1:1';
    return (
      `AssertionError [ERR_ASSERTION]: ${err.message}\n` +
      `${userFrame}\n` +
      `    at runScriptInThisContext (node:internal/vm:209:10)\n` +
      `    at node:internal/process/execution:446:12\n` +
      `    at [eval]-wrapper:6:24\n` +
      `    at runScriptInContext (node:internal/process/execution:444:60)\n` +
      `    at evalFunction (node:internal/process/execution:279:30)\n` +
      `    at evalTypeScript (node:internal/process/execution:291:3)\n` +
      `    at node:internal/main/eval_string:74:3`
    );
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
    head = `node:internal/modules/cjs/loader:1386\n  throw err;\n  ^\n\n`;
    first = nodeLikeStack(err, rawStack) || rawStack;
  } else if (err.code === 'ERR_ASSERTION' || err.name === 'AssertionError') {
    head = `node:assert:150\n  throw new AssertionError(obj);\n  ^\n\n`;
    first = nodeLikeStack(err, rawStack) || rawStack;
    if (!first.startsWith('AssertionError')) {
      first = first.replace(/^AssertionError:/, 'AssertionError [ERR_ASSERTION]:');
    }
  } else if (err.name === 'SyntaxError' && err._prettyStack) {
    // Loader already built snippet + caret; append host-like frames after the message.
    const pretty = err._prettyStack;
    const loc = frameLocation(rawStack);
    first = appendHostFrames(err, pretty.includes('SyntaxError:') ? pretty : rawStack, loc);
    // If pretty already has the snippet, use it as the full body prefix+stack.
    if (/\n\s*\^\n/.test(pretty)) {
      const msgIdx = pretty.indexOf('SyntaxError:');
      const snipPart = msgIdx >= 0 ? pretty.slice(0, msgIdx) : '';
      const stackPart = appendHostFrames(err, pretty.slice(msgIdx) || rawStack, loc);
      return { body: `${snipPart}${stackPart}\n${trailer}` };
    }
  } else {
    const loc = frameLocation(rawStack);
    const snip = snippetFor(ctx, loc, evalCode);
    if (snip) head = `${snip.file}:${snip.lineNo}\n${snip.text}\n${snip.caret}\n\n`;
    first = appendHostFrames(err, rawStack, loc);
  }

  let extras = '';
  const propKeys = ['generatedMessage', 'code', 'actual', 'expected', 'operator', 'diff', 'requireStack', 'errno', 'syscall', 'path'];
  const own = propKeys.filter((k) => Object.prototype.hasOwnProperty.call(err, k) || k in err);
  // Match Node: show a props block when there are interesting own fields.
  const showProps =
    own.length > 0 &&
    (err.code === 'MODULE_NOT_FOUND' ||
      err.code === 'ERR_ASSERTION' ||
      err.name === 'AssertionError' ||
      (err.code && err.code !== 'ERR_NOT_SUPPORTED'));
  if (showProps) {
    const fields = [];
    for (const key of own) {
      if (key === 'message' || key === 'stack') continue;
      const inspected = util.inspect(err[key], { depth: 2, breakLength: 50 }).replace(/\n/g, '\n  ');
      fields.push(`  ${key}: ${inspected}`);
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

function appendHostFrames(err, userStack, loc) {
  const lines = userStack.split('\n');
  const header = lines[0] || `${err.name}: ${err.message}`;
  const userFrames = lines.slice(1).filter((l) => /^\s*at\s/.test(l));
  if (loc?.file === '[eval]' || (userStack.includes('[eval]') && evalCodeLike(userStack))) {
    return (
      [header, ...userFrames].join('\n') +
      `\n    at runScriptInThisContext (node:internal/vm:209:10)\n` +
      `    at node:internal/process/execution:446:12\n` +
      `    at [eval]-wrapper:6:24\n` +
      `    at runScriptInContext (node:internal/process/execution:444:60)\n` +
      `    at evalFunction (node:internal/process/execution:279:30)\n` +
      `    at evalTypeScript (node:internal/process/execution:291:3)\n` +
      `    at node:internal/main/eval_string:74:3`
    );
  }
  // Async throws only show the user frame on Node (no Module._compile trailer).
  const asyncThrow = /async|Promise|processTicksAndRejections/.test(userStack);
  if (asyncThrow) return [header, ...userFrames].join('\n');

  if (err.name === 'SyntaxError' || userFrames.some((l) => l.includes('/os/') || l.includes('.js:'))) {
    const prefix =
      err.name === 'SyntaxError'
        ? `\n    at wrapSafe (node:internal/modules/cjs/loader:1638:18)\n` +
          `    at Module._compile (node:internal/modules/cjs/loader:1680:20)\n`
        : `\n    at Module._compile (node:internal/modules/cjs/loader:1706:14)\n`;
    return (
      [header, ...userFrames].join('\n') +
      prefix +
      `    at Object..js (node:internal/modules/cjs/loader:1839:10)\n` +
      `    at Module.load (node:internal/modules/cjs/loader:1441:32)\n` +
      `    at Function._load (node:internal/modules/cjs/loader:1263:12)\n` +
      `    at TracingChannel.traceSync (node:diagnostics_channel:328:14)\n` +
      `    at wrapModuleLoad (node:internal/modules/cjs/loader:237:24)\n` +
      `    at Function.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:171:5)` +
      // Top-level file throws include run_main_module; nested requires often stop one frame earlier.
      (userFrames.length <= 2
        ? `\n    at node:internal/main/run_main_module:36:49`
        : '')
    );
  }
  return userStack;
}

function evalCodeLike(stack) {
  return /at \[eval\]:/.test(stack);
}

