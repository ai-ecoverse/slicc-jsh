import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPerfHooks } from '../../src/runtime/builtins/perf-hooks.mjs';

// In Chromium the program's `performance` is the browser's: perf_hooks adds
// Node's timerify and eventLoopUtilization to it (host Node's own has them,
// so the kernel goldens never see the additions).
describe('perf_hooks on a performance object without Node extras', () => {
  it('adds timerify and eventLoopUtilization, keeping performance itself', () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'performance');
    const browserish = { now: () => 1234.5, timeOrigin: 0 };
    Object.defineProperty(globalThis, 'performance', { value: browserish, configurable: true, writable: true });
    try {
      const { performance } = createPerfHooks();
      assert.equal(performance, browserish);
      const f = performance.timerify(function foo(a) {
        return a * 2;
      });
      assert.deepEqual([f(2), f.name, f.length], [4, 'timerified foo', 1]);
      class C {}
      assert.ok(new (performance.timerify(C))() instanceof C);
      assert.throws(() => performance.timerify(1), { code: 'ERR_INVALID_ARG_TYPE' });
      const elu = performance.eventLoopUtilization();
      assert.deepEqual(Object.keys(elu), ['idle', 'active', 'utilization']);
      assert.deepEqual(Object.keys(performance.eventLoopUtilization(elu)), ['idle', 'active', 'utilization']);
    } finally {
      Object.defineProperty(globalThis, 'performance', saved);
    }
  });
});
