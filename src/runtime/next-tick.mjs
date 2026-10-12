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
  let stopped = false;

  return {
    nextTick(fn, ...args) {
      if (typeof fn !== 'function') {
        let received = `type ${typeof fn}`;
        if (typeof fn === 'number' || typeof fn === 'boolean' || typeof fn === 'bigint') {
          received = `type ${typeof fn} (${fn})`;
        } else if (typeof fn === 'string') {
          received = `type string ('${fn}')`;
        }
        const err = new TypeError(
          `The "callback" argument must be of type function. Received ${received}`
        );
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      if (!stopped) queue.push(() => fn(...args));
    },
    /** process.exit(): drop what is queued and ignore new ticks. */
    stop() {
      stopped = true;
      queue.length = 0;
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
