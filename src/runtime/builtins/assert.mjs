/** Minimal assert / assert/strict for M1 goldens. */

function defaultMessage({ actual, expected, operator }) {
  if (operator === 'strictEqual' || operator === '==') {
    return 'Expected values to be strictly equal:';
  }
  if (operator === 'deepStrictEqual' || operator === 'deepEqual') {
    return 'Expected values to be strictly deep-equal:';
  }
  if (operator === '==' || !operator) {
    return 'The expression evaluated to a falsy value:';
  }
  return `${String(actual)} ${operator} ${String(expected)}`;
}

class AssertionError extends Error {
  constructor({ message, actual, expected, operator } = {}) {
    const generated = !message;
    super(message || defaultMessage({ actual, expected, operator }));
    this.name = 'AssertionError';
    this.actual = actual;
    this.expected = expected;
    this.operator = operator || '';
    this.generatedMessage = generated;
    this.code = 'ERR_ASSERTION';
  }
}

function ok(value, message) {
  if (!value) {
    throw new AssertionError({
      message: message || 'The expression evaluated to a falsy value:',
      actual: value,
      expected: true,
      operator: '==',
    });
  }
}

function equal(actual, expected, message) {
  // biome-ignore lint: Node assert.equal is loose
  if (actual != expected) {
    throw new AssertionError({ message, actual, expected, operator: '==' });
  }
}

function strictEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    const msg =
      message ||
      `Expected values to be strictly equal:\n\n${String(actual)} !== ${String(expected)}\n`;
    throw new AssertionError({
      message: message ? `${message}\n\n${String(actual)} !== ${String(expected)}\n` : msg,
      actual,
      expected,
      operator: 'strictEqual',
    });
  }
}

function deepEqual(a, b, message) {
  if (!deepEq(a, b, false)) {
    throw new AssertionError({ message, actual: a, expected: b, operator: 'deepEqual' });
  }
}

function deepStrictEqual(a, b, message) {
  if (!deepEq(a, b, true)) {
    throw new AssertionError({ message, actual: a, expected: b, operator: 'deepStrictEqual' });
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
      throw new AssertionError({ message: message || 'wrong error type', actual: err, expected: error, operator: 'throws' });
    }
  }
  if (!threw) throw new AssertionError({ message: message || 'Missing expected exception', operator: 'throws' });
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
