/**
 * The program's async context: which store each AsyncLocalStorage has now.
 *
 * Node carries it with async_hooks: every async resource holds the context
 * of the code that made it. jsh can only carry it where it makes the
 * resource itself. The context goes into process.nextTick, the timers and
 * immediates, queueMicrotask, the reactions given to .then / .catch /
 * .finally, and AsyncResource (bind, runInAsyncScope, AsyncLocalStorage.bind
 * and snapshot). A native `await` continuation is the engine's own job:
 * it resumes with the context outside every run (fail safe: a store goes
 * missing, it's never another run's).
 *
 * A frame is null (no store anywhere) or a Map from storage to its store.
 * Frames are immutable once made; run() swaps one in for the length of a
 * synchronous call and always swaps the previous one back. So does every
 * callback jsh schedules, which keeps an enterWith inside a callback to it.
 */
let current = null;
// How many runInFrame calls are on the stack: 0 means the code running now
// was entered by something jsh doesn't see (a native await continuation, or
// a callback of the runtime's own I/O), whose end jsh can't restore after.
let depth = 0;

/** The frame now (captured by whatever schedules a callback). */
export function currentFrame() {
  return current;
}

/** Whether jsh entered the code running now (so it puts the frame back after). */
export function inTrackedCall() {
  return depth > 0 || mainDepth > 0;
}

// The program's own synchronous start (the main module, -e, stdin): jsh
// called it, so an enterWith there is the program's and ends with it.
let mainDepth = 0;

/** The main module's (or -e's) synchronous run begins. */
export function mainBegin() {
  mainDepth++;
}

/** It ended: what it entered with enterWith reaches only what it scheduled. */
export function mainEnd() {
  mainDepth--;
  if (mainDepth === 0 && depth === 0) current = null;
}

/** Call `fn` with `frame` as the context, then always put the previous one back. */
export function runInFrame(frame, fn, thisArg, args) {
  const previous = current;
  current = frame;
  depth++;
  try {
    return Reflect.apply(fn, thisArg, args);
  } finally {
    depth--;
    current = previous;
  }
}

/** enterWith: the frame stays until the tracked call that is running ends. */
export function enterFrame(frame) {
  current = frame;
}

/** `fn`, called in the frame of now, with the previous frame put back after. */
export function bindToCurrent(fn) {
  if (typeof fn !== 'function') return fn;
  const frame = current;
  return function bound(...args) {
    return runInFrame(frame, fn, this, args);
  };
}

let installed = false;

/**
 * Carry the context into promise reactions and queueMicrotask, from the
 * first AsyncLocalStorage on (until then nothing has a store to carry, and
 * Promise.prototype.then stays the engine's).
 */
export function installPropagation() {
  if (installed) return;
  installed = true;
  const P = globalThis.Promise;
  const nativeThen = P.prototype.then;
  const then = {
    then(onFulfilled, onRejected) {
      // Every reaction runs in a tracked call, so an enterWith inside one
      // ends with it.
      onFulfilled = bindToCurrent(onFulfilled);
      onRejected = bindToCurrent(onRejected);
      return Reflect.apply(nativeThen, this, [onFulfilled, onRejected]);
    },
  }.then;
  try {
    Object.defineProperty(P.prototype, 'then', { value: then, writable: true, enumerable: false, configurable: true });
  } catch {
    /* a locked-down realm: reactions don't carry the context */
  }
  const nativeQueueMicrotask = globalThis.queueMicrotask;
  if (typeof nativeQueueMicrotask === 'function') {
    const queueMicrotask = {
      queueMicrotask(callback) {
        return Reflect.apply(nativeQueueMicrotask, globalThis, [bindToCurrent(callback)]);
      },
    }.queueMicrotask;
    try {
      Object.defineProperty(globalThis, 'queueMicrotask', {
        value: queueMicrotask,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } catch {
      /* locked down */
    }
  }
}
