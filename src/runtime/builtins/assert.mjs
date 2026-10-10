/** assert / assert/strict with Node-like messages for M1 cert. */

function inspectish(v) {
  if (typeof v === 'string') return `'${v.replace(/'/g, "\\'")}'`;
  if (typeof v === 'object' && v !== null) {
    try {
      return JSON.stringify(v, null, 2)
        .split('\n')
        .map((l, i) => (i === 0 ? l : `  ${l}`))
        .join('\n');
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function deepDiffMessage(actual, expected) {
  // Match Node's simple object diff shape used by the cert cases.
  const a = actual && typeof actual === 'object' ? actual : { value: actual };
  const b = expected && typeof expected === 'object' ? expected : { value: expected };
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const lines = ['Expected values to be strictly deep-equal:', '+ actual - expected', ''];
  lines.push('  {');
  for (const k of keys) {
    if (!Object.is(a[k], b[k])) {
      if (k in a) lines.push(`+   ${k}: ${inspectish(a[k])}`);
      if (k in b) lines.push(`-   ${k}: ${inspectish(b[k])}`);
    } else {
      lines.push(`    ${k}: ${inspectish(a[k])}`);
    }
  }
  lines.push('  }');
  lines.push('');
  return lines.join('\n');
}

class AssertionError extends Error {
  constructor({ message, actual, expected, operator, diff } = {}) {
    const generated = !message;
    super(message || 'AssertionError');
    this.name = 'AssertionError';
    this.actual = actual;
    this.expected = expected;
    this.operator = operator || '';
    this.generatedMessage = generated;
    this.code = 'ERR_ASSERTION';
    this.diff = diff ?? 'simple';
  }
}

function ok(value, message) {
  if (!value) {
    throw new AssertionError({
      message: message || 'The expression evaluated to a falsy value:\n\n  a.ok(false)\n',
      actual: value,
      expected: true,
      operator: '==',
    });
  }
}

function equal(actual, expected, message) {
  // biome-ignore lint: Node assert.equal is loose
  if (actual != expected) {
    throw new AssertionError({
      message: message || `Expected values to be loosely equal:\n\n${actual} != ${expected}\n`,
      actual,
      expected,
      operator: '==',
    });
  }
}

function strictEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    const diff = `${String(actual)} !== ${String(expected)}\n`;
    const msg = message
      ? `${message}\n\n${diff}`
      : `Expected values to be strictly equal:\n\n${diff}`;
    throw new AssertionError({
      message: msg,
      actual,
      expected,
      operator: 'strictEqual',
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
        `The input did not match the regular expression ${regexp}. Input:\n\n${inspectish(String(value))}\n`,
      actual: value,
      expected: regexp,
      operator: 'match',
    });
  }
}

function deepEqual(a, b, message) {
  if (!deepEq(a, b, false)) {
    throw new AssertionError({
      message: message || deepDiffMessage(a, b),
      actual: a,
      expected: b,
      operator: 'deepEqual',
    });
  }
}

function deepStrictEqual(a, b, message) {
  if (!deepEq(a, b, true)) {
    throw new AssertionError({
      message: message || deepDiffMessage(a, b),
      actual: a,
      expected: b,
      operator: 'deepStrictEqual',
    });
  }
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
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEq(a[k], b[k], strict, seen)) return false;
  }
  return true;
}

function throws(fn, error, message) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    if (typeof error === 'function' && !(err instanceof error)) {
      throw new AssertionError({
        message: message || 'wrong error type',
        actual: err,
        expected: error,
        operator: 'throws',
      });
    }
    if (error instanceof RegExp && !error.test(String(err))) {
      throw new AssertionError({
        message: message || 'The error did not match the expected pattern',
        actual: err,
        expected: error,
        operator: 'throws',
      });
    }
  }
  if (!threw) {
    throw new AssertionError({
      message: message || 'Missing expected exception.',
      operator: 'throws',
    });
  }
}

function fail(message) {
  throw new AssertionError({ message: message || 'Failed' });
}

function buildAssert({ equal: equalFn, deepEqual: deepEqualFn }) {
  function assertOk(value, message) {
    return ok(value, message);
  }
  return Object.assign(assertOk, {
    ok: assertOk,
    equal: equalFn,
    strictEqual,
    notStrictEqual,
    match,
    deepEqual: deepEqualFn,
    deepStrictEqual,
    throws,
    AssertionError,
    fail,
  });
}

export function createAssert() {
  return buildAssert({ equal, deepEqual });
}

export function createAssertStrict() {
  return buildAssert({ equal: strictEqual, deepEqual: deepStrictEqual });
}
