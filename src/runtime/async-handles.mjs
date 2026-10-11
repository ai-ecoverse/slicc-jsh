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

/** Resolve after the current microtask queue has been fully drained. */
function afterMicrotasks() {
  return new Promise((resolve) => {
    queueMicrotask(() => {
      queueMicrotask(resolve);
    });
  });
}

/**
 * Drain microtasks then nextTick until a full idle checkpoint.
 * Nested `.then` queued inside a promise job must run before nextTick queued
 * from that same job (Node: micro, then tick).
 */
async function checkpoint(nextTick) {
  let idle = 0;
  for (let i = 0; i < 256; i++) {
    await afterMicrotasks();
    nextTick.flushSync();
    if (nextTick.depth > 0) {
      idle = 0;
      continue;
    }
    idle++;
    if (idle >= 6) break;
  }
}

/**
 * Drain microtasks then nextTick. Whenever a handle wakes us (I/O, timer,
 * tracked promise), checkpoint again so nextTicks queued by that work — e.g.
 * readable-stream's deferred 'data'/'end' — run before we wait or exit.
 */
export async function drainLoop(handles, nextTick, { onBeforeExit } = {}) {
  for (;;) {
    await checkpoint(nextTick);
    if (handles.refCount > 0) {
      await handles.waitForProgress();
      // I/O continuations often run as microtasks during the await above and
      // queue nextTicks; drain those before waiting again.
      await checkpoint(nextTick);
      continue;
    }
    if (onBeforeExit) {
      onBeforeExit();
      await checkpoint(nextTick);
      if (handles.refCount > 0) continue;
    }
    return;
  }
}
