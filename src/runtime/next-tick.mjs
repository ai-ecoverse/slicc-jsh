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
  // Ticks run so far (the drain loop's measure of progress).
  let ran = 0;

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
      if (stopped) return;
      // The domain the tick was queued in (lib/domain.js), entered while it
      // runs; a throw leaves it entered for the uncaught-exception path (its
      // error handler exits it), as Node's skipped after-hook does.
      const domain = globalThis.process?.domain ?? undefined;
      if (!domain) queue.push(() => fn(...args));
      else {
        queue.push(() => {
          domain.enter();
          fn(...args);
          domain.exit();
        });
      }
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
        for (let i = 0; i < batch.length; i++) {
          try {
            ran++;
            batch[i]();
          } catch (err) {
            // The rest of the batch still runs (after the error is handled).
            queue.unshift(...batch.slice(i + 1));
            throw err;
          }
        }
      }
    },
    get depth() {
      return queue.length;
    },
    get ran() {
      return ran;
    },
  };
}
