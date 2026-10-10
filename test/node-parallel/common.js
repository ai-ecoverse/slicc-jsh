'use strict';
/**
 * Minimal Node test/common shim for a sliced parallel suite.
 * Enough for buffer/fs/assert/stream fixtures we vendor.
 */

const assert = require('assert');

const mustCallChecks = [];

function runCallChecks() {
  for (const { name, times, count } of mustCallChecks) {
    if (count !== times) {
      throw new Error(`Mismatched ${name} function calls. Expected ${times}, actual ${count}`);
    }
  }
}

process.on('exit', runCallChecks);

function mustCall(fn, exact) {
  if (typeof fn === 'number') {
    exact = fn;
    fn = undefined;
  }
  exact = exact === undefined ? 1 : exact;
  const name = (fn && fn.name) || 'function';
  const ctx = { name, times: exact, count: 0 };
  mustCallChecks.push(ctx);
  return function mustCallWrapper(...args) {
    ctx.count++;
    if (fn) return fn.apply(this, args);
  };
}

function mustNotCall(msg) {
  return function mustNotCallWrapper() {
    throw new Error(msg || 'function should not have been called');
  };
}

function mustSucceed(fn) {
  return mustCall((...args) => {
    const err = args[0];
    assert.ifError(err);
    if (fn) return fn(...args.slice(1));
  });
}

function expectsError(fn, opts) {
  try {
    fn();
  } catch (err) {
    if (opts?.code) assert.strictEqual(err.code, opts.code);
    if (opts?.name) assert.strictEqual(err.name, opts.name);
    return;
  }
  assert.fail(`Expected error${opts?.code ? ` ${opts.code}` : ''}`);
}

function getArrayBufferViews(buf) {
  return [
    new Uint8Array(buf),
    new Uint16Array(buf.buffer || buf, 0, Math.floor((buf.byteLength || buf.length) / 2) || 0),
  ].filter((v) => v.byteLength > 0 || buf.length === 0);
}

module.exports = {
  mustCall,
  mustNotCall,
  mustSucceed,
  expectsError,
  getArrayBufferViews,
  isWindows: false,
  isLinux: true,
  isOSX: false,
  hasCrypto: false,
  hasIntl: false,
  skip: (msg) => {
    console.log(`1..0 # SKIP ${msg || ''}`);
    process.exit(0);
  },
  platformTimeout: (ms) => ms,
  get tmpdir() {
    return require('./common/tmpdir');
  },
};
