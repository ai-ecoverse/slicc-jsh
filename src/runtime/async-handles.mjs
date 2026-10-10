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
 * Drain microtasks then nextTick. Nested `.then` queued inside a promise job must
 * run before nextTick queued from that same job (Node: micro, tick).
 */
export async function drainLoop(handles, nextTick, { onBeforeExit } = {}) {
  for (;;) {
    for (let i = 0; i < 64; i++) {
      await afterMicrotasks();
      nextTick.flushSync();
      if (handles.refCount === 0 && nextTick.depth === 0) break;
      if (handles.refCount > 0) break;
    }
    if (handles.refCount > 0) {
      await handles.waitForProgress();
      continue;
    }
    if (onBeforeExit) {
      onBeforeExit();
      await afterMicrotasks();
      nextTick.flushSync();
      if (handles.refCount > 0) continue;
    }
    return;
  }
}
