/**
 * The program's async context: which store each AsyncLocalStorage has now.
 *
 * Node carries it with async_hooks: every async resource holds the context
 * of the code that made it. jsh can only carry it where it makes the
 * resource itself. The context goes into process.nextTick, the timers and
 * immediates, queueMicrotask, the reactions given to .then / .catch /
 * .finally, and AsyncResource (bind, runInAsyncScope, AsyncLocalStorage.bind
 * and snapshot), and the callbacks of jsh's own I/O (net, http, child
 * stdio). A native `await` continuation is the engine's own job: with the
 * kernel's ctx.asyncContext it follows the store, else it resumes with the
 * context outside every run (fail safe: a store goes missing, it's never
 * another run's).
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

let resource = null;
let offered = null;
let host = null;

export function useHostContext(slot) {
  if (typeof slot?.run === 'function' && typeof slot.getStore === 'function' && typeof slot.enterWith === 'function') {
    offered = slot;
  }
}

/** The frame now (captured by whatever schedules a callback). */
export function currentFrame() {
  if (host && depth === 0 && mainDepth === 0) return host.getStore() ?? null;
  return current;
}

/** Whether jsh entered the code running now (so it puts the frame back after). */
export function inTrackedCall() {
  return host !== null || depth > 0 || mainDepth > 0;
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
export function runInFrame(frame, fn, thisArg, args, holder = null) {
  const previous = current;
  const previousHolder = resource;
  current = frame;
  resource = holder;
  depth++;
  try {
    if (host) return host.run(frame, () => Reflect.apply(fn, thisArg, args));
    return Reflect.apply(fn, thisArg, args);
  } finally {
    depth--;
    current = previous;
    resource = previousHolder;
  }
}

export function resourceHere() {
  return { frame: currentFrame() };
}

export function runInResource(holder, fn, thisArg, args) {
  return runInFrame(holder.frame, fn, thisArg, args, holder);
}

/** enterWith: the frame stays until the tracked call that is running ends. */
export function enterFrame(frame) {
  current = frame;
  if (resource) resource.frame = frame;
  host?.enterWith(frame);
}

/** `fn`, called in the frame of now, with the previous frame put back after. */
export function bindToCurrent(fn) {
  if (typeof fn !== 'function') return fn;
  const frame = currentFrame();
  return function bound(...args) {
    return runInFrame(frame, fn, this, args);
  };
}

let installed = false;

const ownQueueMicrotask = globalThis.queueMicrotask;

export function queueMicrotask(callback) {
  return Reflect.apply(ownQueueMicrotask, globalThis, [installed ? bindToCurrent(callback) : callback]);
}

/**
 * Carry the context into promise reactions and queueMicrotask, from the
 * first AsyncLocalStorage on (until then nothing has a store to carry, and
 * Promise.prototype.then stays the engine's).
 */
export function installPropagation() {
  if (installed) return;
  installed = true;
  host = offered;
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
