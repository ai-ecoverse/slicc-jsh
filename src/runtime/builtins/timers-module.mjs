import { trackPromise } from '../async-handles.mjs';

/** require('timers') — re-export the runtime timer functions. */
export function createTimersModule(timers) {
  return {
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    setImmediate: timers.setImmediate,
    clearImmediate: timers.clearImmediate,
  };
}

/** require('timers/promises') */
export function createTimersPromises(timers, handles) {
  return {
    setTimeout(delay, value, options) {
      void options;
      return trackPromise(
        handles,
        new Promise((resolve) => {
          timers.setTimeout(() => resolve(value), delay ?? 0);
        })
      );
    },
    setImmediate(value, options) {
      void options;
      return trackPromise(
        handles,
        new Promise((resolve) => {
          timers.setImmediate(() => resolve(value));
        })
      );
    },
    setInterval() {
      const err = new Error('timers/promises setInterval iterator not implemented');
      err.code = 'ERR_NOT_SUPPORTED';
      throw err;
    },
  };
}
