/**
 * process.nextTick queue.
 *
 * Must NOT schedule via queueMicrotask: Node drains remaining Promise jobs before
 * nextTicks that were queued from inside a microtask (micro, then tick). Auto-
 * scheduling ticks as microtasks inverts that. Drain only via flushSync from the
 * event loop (after script / after a microtask checkpoint / after timers).
 */
export function createNextTick() {
  const queue = [];

  return {
    nextTick(fn, ...args) {
      if (typeof fn !== 'function') {
        const err = new TypeError('callback is not a function');
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      queue.push(() => fn(...args));
    },
    /** Run queued ticks synchronously. */
    flushSync() {
      while (queue.length > 0) {
        const batch = queue.splice(0);
        for (const job of batch) job();
      }
    },
    get depth() {
      return queue.length;
    },
  };
}
