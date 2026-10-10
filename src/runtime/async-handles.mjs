/**
 * Track an in-flight Promise as a ref'd handle so the event loop stays alive
 * (libuv-request style). Every ctx.* Promise must go through this.
 */
export function trackPromise(handles, promise) {
  const handle = { kind: 'promise' };
  handles.add(handle);
  return Promise.resolve(promise).finally(() => {
    handles.delete(handle);
  });
}

/**
 * Drain nextTick + microtasks until quiescent, then wait on ref'd handles.
 * After a promise settles there is a microtask gap before the next await
 * schedules more work — we must flush that gap before treating the loop as empty.
 */
export async function drainLoop(handles, nextTick, { onBeforeExit } = {}) {
  for (;;) {
    for (let i = 0; i < 32; i++) {
      nextTick.flushSync();
      await Promise.resolve();
      nextTick.flushSync();
      if (handles.refCount > 0) break;
    }
    if (handles.refCount > 0) {
      await handles.waitForProgress();
      continue;
    }
    // Node may emit beforeExit multiple times if listeners schedule more work.
    if (onBeforeExit) {
      onBeforeExit();
      nextTick.flushSync();
      await Promise.resolve();
      nextTick.flushSync();
      if (handles.refCount > 0) continue;
    }
    return;
  }
}
