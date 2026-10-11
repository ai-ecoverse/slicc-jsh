import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drainLoop, trackPromise } from '../../src/runtime/async-handles.mjs';
import { createHandleTable } from '../../src/runtime/handles.mjs';
import { createNextTick } from '../../src/runtime/next-tick.mjs';

describe('drainLoop', () => {
  it('flushes nextTick queued while a tracked promise settles', async () => {
    const handles = createHandleTable();
    const nextTick = createNextTick();
    const order = [];

    const io = new Promise((resolve) => {
      setTimeout(() => resolve('ok'), 5);
    });

    void (async () => {
      await trackPromise(handles, io);
      // readable-stream style: schedule work on nextTick from the I/O continuation
      nextTick.nextTick(() => {
        order.push('tick');
      });
      order.push('after-await');
    })();

    await drainLoop(handles, nextTick);
    assert.deepEqual(order, ['after-await', 'tick']);
  });

  it('flushes nextTick queued from notify after push-style work', async () => {
    const handles = createHandleTable();
    const nextTick = createNextTick();
    const order = [];
    const hold = { kind: 'socket' };
    handles.add(hold);

    setTimeout(() => {
      order.push('io');
      nextTick.nextTick(() => order.push('tick'));
      handles.notify();
      handles.delete(hold);
    }, 5);

    await drainLoop(handles, nextTick);
    assert.deepEqual(order, ['io', 'tick']);
  });
});
