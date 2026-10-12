/** assert / assert/strict with Node 22.22.0-like messages. */

import { inspect as nodeInspect } from 'node-inspect-extracted';

const inspect = (v) => nodeInspect(v, { compact: false, breakLength: 80, sorted: true });

class AssertionError extends Error {
  constructor({ message, actual, expected, operator, diff, generatedMessage, throwSite } = {}) {
    const generated = generatedMessage ?? !message;
    super(message || 'AssertionError');
    this.name = 'AssertionError';
    // Own-key order matches Node's uncaught props block.
    this.generatedMessage = generated;
    this.code = 'ERR_ASSERTION';
    this.actual = actual;
    this.expected = expected;
    this.operator = operator || '';
    this.diff = diff ?? 'simple';
    // Node: ok/assert → internal/assert/utils:77; strictEqual etc → node:assert:150
    Object.defineProperty(this, '_assertThrowSite', {
      value: throwSite || 'assert',
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
}

function parseStackFrame(line) {
  const m =
    /at [^\n]*?(?:\[eval\]|(\/[^:\n)]+|[A-Za-z]:[^:\n)]+)):(\d+):(\d+)/.exec(line) ||
    /at (\[eval\]):(\d+):(\d+)/.exec(line) ||
    /at Object\.<anonymous> \((\[eval\]):(\d+):(\d+)\)/.exec(line);
  if (!m) return null;
  const file = m[1] === undefined || String(m[0]).includes('[eval]') ? '[eval]' : m[1];
  return { file, line: Number(m[2]), column: Number(m[3]) };
}

function readSourceFile(ctx, process, file) {
  if (file === '[eval]' || file.includes('[eval]')) {
    return (
      process?._evalCode ??
      process?.__evalCode ??
      ctx?.evalCode ??
      globalThis._evalCode ??
      globalThis.__jsh_evalCode ??
      null
    );
  }
  try {
    const bytes = ctx?.sync?.fs?.readFile(file);
    if (bytes != null) return new TextDecoder().decode(bytes);
  } catch {
    /* missing file */
  }
  return null;
}

function findClosingParen(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractAssertCallFromSource(source, line, column) {
  const lines = source.replace(/^#![^\n]*\n/, '').split('\n');
  if (line < 1 || line > lines.length) return null;
  const startLineIdx = line - 1;
  let text = '';
  for (let i = startLineIdx; i < lines.length; i++) {
    text += lines[i];
    if (i < lines.length - 1) text += '\n';
    if (text.length > 16_384) break;
  }
  const at = Math.max(0, Math.min(column - 1, lines[startLineIdx].length));

  // Node extracts the call text: assert(...), assert.ok(...), or alias.ok(...).
  const re = /\b(?:assert(?:\.ok)?|[A-Za-z_$][\w$]*\.ok)\s*\(/g;
  let match = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const openParen = m.index + m[0].length - 1;
    const close = findClosingParen(text, openParen);
    if (close === -1) continue;
    if (start <= at && at <= close) {
      match = text.slice(start, close + 1);
      const nl = match.indexOf('\n');
      if (nl !== -1) match = `${match.slice(0, nl)}\n`;
    }
  }
  return match?.trimEnd() ?? null;
}

function okExpressionFromStack(ctx, process, value) {
  const err = new Error();
  const stack = err.stack || '';
  for (const line of stack.split('\n').slice(1)) {
    if (/assert\.mjs|node:assert|AssertionError|createAssert/.test(line)) continue;
    const loc = parseStackFrame(line);
    if (!loc) continue;
    const source = readSourceFile(ctx, process, loc.file);
    if (source == null) break;
    const expr = extractAssertCallFromSource(source, loc.line, loc.column);
    if (expr) return expr;
    break;
  }
  return `${inspect(value)} == true`;
}

function deepEq(a, b, strict, seen = new WeakMap()) {
  if (strict ? Object.is(a, b) : a === b) return true;
  // biome-ignore lint: loose deepEqual
  if (!strict && a == b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i], strict, seen)) return false;
    return true;
  }
  const ak = Reflect.ownKeys(a);
  const bk = Reflect.ownKeys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEq(a[k], b[k], strict, seen)) return false;
  }
  return true;
}

function diffMark(sign, indent, text) {
  return `${sign}${indent.length > 0 ? indent.slice(1) : ''}${text}`;
}

function formatArrayElements(actual, expected, indent, lines) {
  const len = Math.max(actual.length, expected.length);
  for (let i = 0; i < len; i++) {
    const ai = actual[i];
    const bi = expected[i];
    const hasA = i in actual;
    const hasB = i in expected;
    if (hasA && hasB && deepEq(ai, bi, true)) {
      if (Array.isArray(ai)) {
        lines.push(`${indent}[`);
        formatArrayElements(ai, bi, `${indent}  `, lines);
        lines.push(`${indent}],`);
      } else if (typeof ai === 'object' && ai !== null) {
        lines.push(`${indent}{`);
        formatObjectDiff(ai, bi, `${indent}  `, lines, false);
        lines.push(`${indent}},`);
      } else {
        lines.push(`${indent}${inspect(ai)},`);
      }
    } else if (hasA && hasB) {
      if (Array.isArray(ai) && Array.isArray(bi)) {
        lines.push(`${indent}[`);
        formatArrayElements(ai, bi, `${indent}  `, lines);
        lines.push(`${indent}],`);
      } else if (
        typeof ai === 'object' &&
        ai !== null &&
        typeof bi === 'object' &&
        bi !== null &&
        !Array.isArray(ai)
      ) {
        lines.push(`${indent}{`);
        formatObjectDiff(ai, bi, `${indent}  `, lines, false);
        lines.push(`${indent}},`);
      } else {
        lines.push(diffMark('+', indent, inspect(ai)));
        lines.push(diffMark('-', indent, inspect(bi)));
      }
    } else if (hasA) {
      lines.push(diffMark('+', indent, inspect(ai)));
    } else {
      lines.push(diffMark('-', indent, inspect(bi)));
    }
  }
}

function formatObjectDiff(actual, expected, indent, lines, wrap = true) {
  if (wrap) lines.push(`${indent}{`);
  const keys = [...new Set([...Reflect.ownKeys(actual), ...Reflect.ownKeys(expected)])];
  for (const k of keys) {
    const hasA = Object.prototype.hasOwnProperty.call(actual, k);
    const hasB = Object.prototype.hasOwnProperty.call(expected, k);
    const inner = `${indent}  `;
    const label = typeof k === 'symbol' ? `[${inspect(k)}]` : k;
    if (hasA && hasB) {
      const av = actual[k];
      const bv = expected[k];
      if (deepEq(av, bv, true)) {
        if (Array.isArray(av)) {
          lines.push(`${inner}${label}: [`);
          formatArrayElements(av, bv, `${indent}    `, lines);
          lines.push(`${inner}]`);
        } else if (typeof av === 'object' && av !== null) {
          lines.push(`${inner}${label}: {`);
          formatObjectDiff(av, bv, `${indent}    `, lines, false);
          lines.push(`${inner}}`);
        } else {
          lines.push(`${inner}${label}: ${inspect(av)},`);
        }
      } else if (Array.isArray(av) && Array.isArray(bv)) {
        lines.push(`${inner}${label}: [`);
        formatArrayElements(av, bv, `${indent}    `, lines);
        lines.push(`${inner}]`);
      } else if (
        typeof av === 'object' &&
        av !== null &&
        typeof bv === 'object' &&
        bv !== null &&
        !Array.isArray(av)
      ) {
        lines.push(`${inner}${label}: {`);
        formatObjectDiff(av, bv, `${indent}    `, lines, false);
        lines.push(`${inner}}`);
      } else {
        lines.push(diffMark('+', inner, `${label}: ${inspect(av)}`));
        lines.push(diffMark('-', inner, `${label}: ${inspect(bv)}`));
      }
    } else if (hasA) {
      lines.push(diffMark('+', inner, `${label}: ${inspect(actual[k])}`));
    } else {
      lines.push(diffMark('-', inner, `${label}: ${inspect(expected[k])}`));
    }
  }
  if (wrap) lines.push(`${indent}}`);
}

function comparisonDeepEqualMessage(actual, expected) {
  const lines = ['Expected values to be strictly deep-equal:', '+ actual - expected', ''];
  lines.push('  Comparison {');
  const keys = Object.keys(expected);
  const diffKeys = keys.filter((k) => !deepEq(actual[k], expected[k], true));
  const sameKeys = keys.filter((k) => deepEq(actual[k], expected[k], true));
  for (const k of diffKeys) {
    lines.push(diffMark('+', '    ', `${k}: ${inspect(actual[k])},`));
    lines.push(diffMark('-', '    ', `${k}: ${inspect(expected[k])},`));
  }
  for (const k of sameKeys) {
    lines.push(`    ${k}: ${inspect(actual[k])}`);
  }
  lines.push('  }');
  lines.push('');
  return lines.join('\n');
}

function deepStrictEqualMessage(actual, expected) {
  const lines = ['Expected values to be strictly deep-equal:', '+ actual - expected', ''];
  if (Array.isArray(actual) && Array.isArray(expected)) {
    lines.push('  [');
    formatArrayElements(actual, expected, '    ', lines);
    lines.push('  ]');
  } else if (
    typeof actual === 'object' &&
    actual !== null &&
    typeof expected === 'object' &&
    expected !== null
  ) {
    formatObjectDiff(actual, expected, '  ', lines);
  } else {
    lines.push(diffMark('+', '  ', inspect(actual)));
    lines.push(diffMark('-', '  ', inspect(expected)));
  }
  lines.push('');
  return lines.join('\n');
}

function deepEqualMessage(actual, expected) {
  return (
    `Expected values to be loosely deep-equal:\n\n${inspect(actual)}\n\n` +
    `should loosely deep-equal\n\n${inspect(expected)}`
  );
}

function notDeepInspectBlock(value) {
  return `\n\n${inspect(value)}\n`;
}

function createApi({ equalFn, deepEqualFn, ctx, process }) {
  function ok(value, message) {
    if (!value) {
      const expr = message ? null : okExpressionFromStack(ctx, process, value);
      throw new AssertionError({
        message:
          message ||
          `The expression evaluated to a falsy value:\n\n  ${expr ?? `${inspect(value)} == true`}\n`,
        actual: value,
        expected: true,
        operator: '==',
        generatedMessage: !message,
        throwSite: 'utils',
      });
    }
  }

  function strictEqual(actual, expected, message) {
    if (!Object.is(actual, expected)) {
      const diff = `${inspect(actual)} !== ${inspect(expected)}\n`;
      const msg = message
        ? message.includes('!==') || message === diff.trim()
          ? message
          : `${message}\n\n${diff}`
        : `Expected values to be strictly equal:\n\n${diff}`;
      throw new AssertionError({
        message: msg,
        actual,
        expected,
        operator: 'strictEqual',
        generatedMessage: !message,
      });
    }
  }

  function notStrictEqual(actual, expected, message) {
    if (Object.is(actual, expected)) {
      throw new AssertionError({
        message: message || `Expected "actual" to be strictly unequal to: ${actual}`,
        actual,
        expected,
        operator: 'notStrictEqual',
      });
    }
  }

  function match(value, regexp, message) {
    if (typeof regexp?.test !== 'function' || !regexp.test(String(value))) {
      throw new AssertionError({
        message:
          message ||
          `The input did not match the regular expression ${regexp}. Input:\n\n${inspect(String(value))}\n`,
        actual: value,
        expected: regexp,
        operator: 'match',
      });
    }
  }

  function doesNotMatch(value, regexp, message) {
    if (typeof regexp?.test === 'function' && regexp.test(String(value))) {
      throw new AssertionError({
        message:
          message ||
          `The input was expected to not match the regular expression ${regexp}. Input:\n\n${inspect(String(value))}\n`,
        actual: value,
        expected: regexp,
        operator: 'doesNotMatch',
      });
    }
  }

  function deepStrictEqual(a, b, message) {
    if (!deepEq(a, b, true)) {
      throw new AssertionError({
        message: message || deepStrictEqualMessage(a, b),
        actual: a,
        expected: b,
        operator: 'deepStrictEqual',
      });
    }
  }

  function notDeepStrictEqual(actual, expected, message) {
    if (deepEq(actual, expected, true)) {
      throw new AssertionError({
        message:
          message ||
          `Expected "actual" not to be strictly deep-equal to:${notDeepInspectBlock(expected)}`,
        actual,
        expected,
        operator: 'notDeepStrictEqual',
      });
    }
  }

  function notDeepEqual(actual, expected, message) {
    if (deepEq(actual, expected, false)) {
      throw new AssertionError({
        message:
          message ||
          `Expected "actual" not to be loosely deep-equal to:${notDeepInspectBlock(expected)}`,
        actual,
        expected,
        operator: 'notDeepEqual',
      });
    }
  }

  // Node 22's expectedException (lib/assert.js).
  function validateThrown(err, error, operator = 'throws') {
    if (error == null) return;
    const fail = (message) => {
      throw new AssertionError({ message, actual: err, expected: error, operator, generatedMessage: true });
    };
    if (typeof error !== 'function') {
      if (error instanceof RegExp) {
        const str = String(err);
        if (error.exec(str) !== null) return;
        fail(`The input did not match the regular expression ${inspect(error)}. Input:\n\n${inspect(str)}\n`);
      }
      if (typeof err !== 'object' || err === null) {
        throw new AssertionError({ actual: err, expected: error, operator });
      }
      const keys = Object.keys(error);
      if (error instanceof Error) keys.push('name', 'message');
      for (const key of keys) {
        if (typeof err[key] === 'string' && error[key] instanceof RegExp && error[key].exec(err[key]) !== null) {
          continue;
        }
        if (!(key in err) || !deepEq(err[key], error[key], true)) {
          const actual = {};
          const expected = {};
          for (const k of keys) {
            if (k in err) actual[k] = err[k];
            expected[k] = error[k];
          }
          fail(comparisonDeepEqualMessage(actual, expected));
        }
      }
      return;
    }
    // Guard instanceof against arrow functions as they don't have a prototype.
    if (error.prototype !== undefined && err instanceof error) return;
    if (Object.prototype.isPrototypeOf.call(Error, error)) {
      let message = `The error is expected to be an instance of "${error.name}". Received `;
      if (err instanceof Error) {
        const name = err.constructor?.name || err.name;
        message += error.name === name ? 'an error with identical name but a different prototype.' : `"${name}"`;
        if (err.message) message += `\n\nError message:\n\n${err.message}`;
      } else {
        message += `"${inspect(err, { depth: -1 })}"`;
      }
      fail(message);
    }
    // A validation function.
    const res = Reflect.apply(error, {}, [err]);
    if (res !== true) {
      const name = error.name ? `"${error.name}" ` : '';
      let message = `The ${name}validation function is expected to return "true". Received ${inspect(res)}`;
      if (err instanceof Error) message += `\n\nCaught error:\n\n${err}`;
      fail(message);
    }
  }

  function throws(fn, error, message) {
    if (typeof fn !== 'function') {
      throw new TypeError('ERR_INVALID_ARG_TYPE');
    }
    let threw = false;
    let thrown;
    try {
      thrown = fn();
    } catch (err) {
      threw = true;
      thrown = err;
      validateThrown(err, error);
    }
    if (!threw) {
      throw new AssertionError({
        message: message || 'Missing expected exception.',
        operator: 'throws',
      });
    }
    // Node's assert.throws returns undefined.
    return undefined;
  }

  function doesNotThrow(fn, error, message) {
    if (typeof fn !== 'function') {
      throw new TypeError('ERR_INVALID_ARG_TYPE');
    }
    try {
      fn();
    } catch (err) {
      if (error != null) validateThrown(err, error);
      const msgText = err?.message ?? String(err);
      throw new AssertionError({
        message: message || `Got unwanted exception.\nActual message: ${JSON.stringify(msgText)}`,
        actual: err,
        operator: 'doesNotThrow',
      });
    }
  }

  function isThenable(v) {
    return v != null && typeof v.then === 'function';
  }

  async function rejects(block, error, message) {
    let promise;
    if (typeof block === 'function') {
      try {
        promise = block();
      } catch (err) {
        validateThrown(err, error, 'rejects');
        return undefined;
      }
    } else {
      promise = block;
    }
    if (!isThenable(promise)) {
      throw new AssertionError({
        message: message || 'Missing expected rejection.',
        operator: 'rejects',
        generatedMessage: !message,
      });
    }
    try {
      await promise;
      throw new AssertionError({
        message: message || 'Missing expected rejection.',
        operator: 'rejects',
        generatedMessage: !message,
      });
    } catch (err) {
      if (err instanceof AssertionError && err.operator === 'rejects') throw err;
      validateThrown(err, error, 'rejects');
      return undefined;
    }
  }

  async function doesNotReject(block, error, message) {
    let promise;
    if (typeof block === 'function') {
      try {
        promise = block();
      } catch (err) {
        if (error != null) validateThrown(err, error);
        const msgText = err?.message ?? String(err);
        throw new AssertionError({
          message: message || `Got unwanted rejection.\nActual message: ${JSON.stringify(msgText)}`,
          actual: err,
          operator: 'doesNotReject',
          generatedMessage: !message,
        });
      }
    } else {
      promise = block;
    }
    if (!isThenable(promise)) return;
    try {
      await promise;
    } catch (err) {
      if (error != null) validateThrown(err, error, 'doesNotReject');
      const msgText = err?.message ?? String(err);
      throw new AssertionError({
        message:
          message || `Got unwanted rejection.\nActual message: ${JSON.stringify(msgText)}`,
        actual: err,
        operator: 'doesNotReject',
        generatedMessage: !message,
      });
    }
  }

  function ifError(err) {
    if (err != null) {
      if (typeof err === 'string') {
        throw new AssertionError({
          message: `ifError got unwanted exception: ${err}`,
          operator: 'ifError',
          generatedMessage: true,
        });
      }
      throw new AssertionError({
        message: `ifError got unwanted exception: ${err.message}`,
        actual: err,
        operator: 'ifError',
        generatedMessage: true,
      });
    }
  }

  function fail(message, actual, expected, operator, diff) {
    throw new AssertionError({
      message: message || 'Failed',
      actual,
      expected,
      operator: operator || 'fail',
      diff,
      generatedMessage: !message,
    });
  }

  function assertFn(value, message) {
    return ok(value, message);
  }

  return Object.assign(assertFn, {
    ok,
    equal: equalFn,
    strictEqual,
    notStrictEqual,
    deepEqual: deepEqualFn,
    deepStrictEqual,
    notDeepEqual,
    notDeepStrictEqual,
    match,
    doesNotMatch,
    throws,
    doesNotThrow,
    rejects,
    doesNotReject,
    ifError,
    AssertionError,
    fail,
  });
}

export function createAssert(options = {}) {
  const { ctx, process } = options;
  return createApi({
    equalFn(actual, expected, message) {
      // biome-ignore lint: Node assert.equal is loose
      if (actual != expected) {
        throw new AssertionError({
          message: message || `${actual} == ${expected}`,
          actual,
          expected,
          operator: '==',
        });
      }
    },
    deepEqualFn(a, b, message) {
      if (!deepEq(a, b, false)) {
        throw new AssertionError({
          message: message || deepEqualMessage(a, b),
          actual: a,
          expected: b,
          operator: 'deepEqual',
        });
      }
    },
    ctx,
    process,
  });
}

/** @param {{ ctx?: object, process?: object }} [options] */
export function createAssertStrict(options = {}) {
  const { ctx, process } = options;
  return createApi({
    equalFn(actual, expected, message) {
      if (!Object.is(actual, expected)) {
        const diff = `${inspect(actual)} !== ${inspect(expected)}\n`;
        throw new AssertionError({
          message: message
            ? `${message}\n\n${diff}`
            : `Expected values to be strictly equal:\n\n${diff}`,
          actual,
          expected,
          operator: 'strictEqual',
        });
      }
    },
    deepEqualFn(a, b, message) {
      if (!deepEq(a, b, true)) {
        throw new AssertionError({
          message: message || deepStrictEqualMessage(a, b),
          actual: a,
          expected: b,
          operator: 'deepStrictEqual',
        });
      }
    },
    ctx,
    process,
  });
}
