/** process.nextTick queue (not a keep-alive handle). */
export function createNextTick() {
  const queue = [];
  let scheduled = false;

  const drain = () => {
    scheduled = false;
    while (queue.length > 0) {
      const batch = queue.splice(0);
      for (const job of batch) job();
    }
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(drain);
  };

  return {
    nextTick(fn, ...args) {
      if (typeof fn !== 'function') {
        const err = new TypeError('callback is not a function');
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      queue.push(() => fn(...args));
      schedule();
    },
    /** Run queued ticks synchronously (after user script / timer callbacks). */
    flushSync() {
      while (queue.length > 0) {
        const batch = queue.splice(0);
        for (const job of batch) job();
      }
      scheduled = false;
    },
    get depth() {
      return queue.length;
    },
  };
}
