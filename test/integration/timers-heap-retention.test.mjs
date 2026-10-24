import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createTimers } from '../../src/runtime/timers.mjs';
import { createHandleTable } from '../../src/runtime/handles.mjs';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');
const ROUNDS = 500;

async function retained(round) {
  const timers = createTimers(createHandleTable(), {});
  timers.startLoop();
  const refs = [];
  for (let i = 0; i < ROUNDS; i++) {
    const payload = new Uint8Array(16);
    refs.push(new WeakRef(payload));
    await round(timers, payload);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  const alive = refs.filter((ref) => ref.deref() !== undefined).length;
  timers.clearPending();
  return alive;
}

describe('timers heaps (src)', () => {
  it('drop timeouts set from I/O once they have run, beside immediates', async () => {
    const alive = await retained((timers, payload) => {
      timers.endPhase();
      return Promise.all([
        new Promise((resolve) => timers.setTimeout((p) => resolve(p.length), 0, payload)),
        new Promise((resolve) => timers.setImmediate(resolve)),
      ]);
    });
    assert.ok(alive < 50, `${alive} of ${ROUNDS} payloads still alive`);
  });

  it('drop timeouts and immediates set in the check phase once they have run', async () => {
    const alive = await retained((timers, payload) => new Promise((resolve) => timers.setImmediate(() => {
      let left = 2;
      const done = () => --left === 0 && resolve();
      timers.setImmediate((p) => { p.length; done(); }, payload);
      timers.setTimeout((p) => { p.length; done(); }, 0, payload);
    })));
    assert.ok(alive < 50, `${alive} of ${ROUNDS} payloads still alive`);
  });
});
