import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHandleTable } from '../../src/runtime/handles.mjs';
import { createTimers } from '../../src/runtime/timers.mjs';
import { createPorts } from '../../src/runtime/web/broadcast-channel.mjs';

const nativeSetTimeout = globalThis.setTimeout;

function loop() {
  const handles = createHandleTable();
  const delivering = {
    active: false,
    pending: false,
    cut: 0,
    since: 0,
    overdue: (at) => timers.overdue(at),
    inCheck: () => timers.inCheck(),
    checkCut: () => timers.checkCut(),
    timerAt: () => timers.timerAt(),
    immediatePending: (cut) => timers.immediatePending(cut),
    endTurn: () => timers.startCheck(),
  };
  const ports = createPorts({ handles, schedule: (fn) => timers.setImmediateUnheld(fn), delivering });
  const timers = createTimers(handles, {
    hold: (due) =>
      ((delivering.active || timers.checkPending()) && due > delivering.since) ||
      (delivering.pending && delivering.cut === 0 && due > delivering.postedAt()),
    holdImmediate: (seq) => delivering.active || (delivering.pending && seq >= delivering.cut) || seq >= delivering.closingCut(),
  });
  return { handles, ports, timers };
}

it("a poll-phase immediate left from a port turn isn't the check phase's: a post from outside it, a timeout and it all run", async () => {
  const { handles, ports, timers } = loop();
  const { port1, port2 } = new ports.MessageChannel();
  const seen = [];
  port2.on('message', (m) => {
    seen.push(m);
    if (m !== 'first') return;
    timers.setTimeout(() => seen.push('timeout'), 0);
    nativeSetTimeout(() => {
      nativeSetTimeout(() => port1.postMessage('from outside'), 0);
      timers.setImmediatePoll(() => seen.push('poll immediate'));
    }, 0);
  });
  port1.postMessage('first');
  const start = Date.now();
  let progress = { at: start, count: 0 };
  while (seen.length < 4 && Date.now() - progress.at < 500 && Date.now() - start < 5000) {
    await new Promise((r) => nativeSetTimeout(r, 5));
    if (seen.length !== progress.count) progress = { at: Date.now(), count: seen.length };
  }
  port2.close();
  timers.stop();
  handles.clear();
  assert.deepEqual([...seen].sort(), ['first', 'from outside', 'poll immediate', 'timeout']);
});
