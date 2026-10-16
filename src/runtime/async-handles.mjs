/**
 * Track an in-flight Promise as a ref'd handle so the event loop stays alive
 * (libuv-request style). Every ctx.* Promise must go through this.
 */
export function trackPromise(handles, promise) {
  const handle = { kind: 'promise' };
  handles.add(handle);
  const p = Promise.resolve(promise);
  // Keep the loop alive without creating a second rejecting branch that becomes
  // an unhandledRejection when callers only need the side effect (or also await
  // the original). Caught import() evaluation errors must stay caught.
  p.finally(() => {
    handles.delete(handle);
  }).then(
    () => {},
    () => {}
  );
  return p;
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
async function checkpoint(nextTick, onTickError) {
  let idle = 0;
  for (let i = 0; i < 256; i++) {
    await afterMicrotasks();
    // A tick that throws is an uncaught exception (Node's), handled as one,
    // and the rest of the queue runs on before any promise job (Node's
    // processTicksAndRejections goes on with it).
    const before = nextTick.ran;
    for (;;) {
      try {
        nextTick.flushSync();
        break;
      } catch (err) {
        if (!onTickError) throw err;
        onTickError(err);
      }
    }
    // Ticks ran (their promise jobs may queue more): not idle yet.
    if (nextTick.depth > 0 || nextTick.ran !== before) {
      idle = 0;
      continue;
    }
    idle++;
    if (idle >= 6) return false;
  }
  // Still running ticks after all its turns.
  return true;
}

// Captured before the runtime installs its own (handle-counting) timers.
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

/**
 * Macrotask turns the loop waits, with no ref'd handle left, for a pending
 * entry promise (`weakPending`) to make progress. Node knows every request it
 * has in flight; we only know the ones we track (timers, ctx I/O, fetch,
 * WebCrypto, WebAssembly). This covers the few platform promises that settle
 * on a task of their own (Blob reads, a constructed Response's body).
 */
const ENTRY_GRACE_TURNS = 8;

function macrotask() {
  return new Promise((resolve) => {
    nativeSetTimeout(resolve, 0);
  });
}

/**
 * Drain microtasks then nextTick. Whenever a handle wakes us (I/O, timer,
 * tracked promise), checkpoint again so nextTicks queued by that work — e.g.
 * readable-stream's deferred 'data'/'end' — run before we wait or exit.
 *
 * `weakPending()` says whether the entry (a `.jsh` body, an ES module's
 * top-level await) is still pending. As in Node, a pending promise by itself
 * does not keep the program alive: the loop ends once nothing is ref'd, after
 * the short grace above.
 */
export async function drainLoop(handles, nextTick, { onBeforeExit, shouldStop, weakPending, onTickError } = {}) {
  for (;;) {
    // A long tick / promise-job chain: go on with it (Node runs it to the end).
    while (await checkpoint(nextTick, onTickError)) {
      if (shouldStop?.()) return;
    }
    // process.exit() from a timer must unwind even while a server is listening.
    if (shouldStop?.()) return;
    if (handles.refCount > 0) {
      // A tick queued since the checkpoint (its wake found no waiter) runs
      // now; otherwise a new tick wakes the wait (createNextTick's onQueue).
      if (nextTick.depth === 0) await handles.waitForProgress();
      if (shouldStop?.()) return;
      // I/O continuations often run as microtasks during the await above and
      // queue nextTicks; drain those before waiting again.
      await checkpoint(nextTick, onTickError);
      continue;
    }
    if (weakPending?.()) {
      for (let i = 0; i < ENTRY_GRACE_TURNS; i++) {
        await macrotask();
        await checkpoint(nextTick, onTickError);
        if (shouldStop?.() || handles.refCount > 0 || !weakPending()) break;
      }
      if (shouldStop?.()) return;
      if (handles.refCount > 0 || !weakPending()) continue;
    }
    if (onBeforeExit) {
      onBeforeExit();
      await checkpoint(nextTick, onTickError);
      if (shouldStop?.()) return;
      if (handles.refCount > 0) continue;
    }
    return;
  }
}
