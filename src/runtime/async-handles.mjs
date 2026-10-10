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
    // Drain microtasks/nextTick generously so floating async IIFEs
    // (for-await of Readable.from(asyncGen)) can schedule their next timer.
    let idle = 0;
    for (let i = 0; i < 256; i++) {
      await afterMicrotasks();
      nextTick.flushSync();
      if (handles.refCount > 0) {
        idle = 0;
        break;
      }
      if (nextTick.depth > 0) {
        idle = 0;
        continue;
      }
      idle++;
      // Several fully-idle rounds before treating the queue as empty.
      if (idle >= 6) break;
    }
    if (handles.refCount > 0) {
      await handles.waitForProgress();
      continue;
    }
    if (onBeforeExit) {
      onBeforeExit();
      idle = 0;
      for (let i = 0; i < 64; i++) {
        await afterMicrotasks();
        nextTick.flushSync();
        if (handles.refCount > 0) break;
        if (nextTick.depth === 0) idle++;
        else idle = 0;
        if (idle >= 6) break;
      }
      if (handles.refCount > 0) continue;
    }
    return;
  }
}
