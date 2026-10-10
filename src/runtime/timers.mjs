/**
 * setTimeout / setInterval with Node's Timeout.ref()/unref() and handle counting.
 * User callbacks run as Timeout._onTimeout so uncaught stacks match Node.
 */

function Timeout() {}

export function createTimers(handles, { onCallbackError } = {}) {
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const nativeSetInterval = globalThis.setInterval.bind(globalThis);
  const nativeClearInterval = globalThis.clearInterval.bind(globalThis);

  const byId = new Map();

  const runOnTimeout = (handle, args) => {
    try {
      handle._onTimeout(...args);
    } catch (err) {
      if (onCallbackError) onCallbackError(err);
      else throw err;
    } finally {
      handles.notify();
    }
  };

  const makeTimeout = (fn, delay, args, repeating) => {
    const state = {
      refed: true,
      id: null,
      repeating,
    };
    const handle = new Timeout();
    handle._onTimeout = fn;
    handle.ref = function ref() {
      if (!state.refed) {
        state.refed = true;
        handles.add(state);
      }
      return handle;
    };
    handle.unref = function unref() {
      if (state.refed) {
        state.refed = false;
        handles.delete(state);
      }
      return handle;
    };
    handle.hasRef = function hasRef() {
      return state.refed;
    };
    handle[Symbol.toPrimitive] = function toPrimitive() {
      return state.id;
    };

    const fire = () => {
      if (!state.repeating) {
        byId.delete(state.id);
        handles.delete(state);
      }
      runOnTimeout(handle, args);
    };
    state.id = repeating ? nativeSetInterval(fire, delay ?? 0) : nativeSetTimeout(fire, delay ?? 0);
    byId.set(state.id, state);
    handles.add(state);
    return handle;
  };

  const clear = (handle, nativeClear) => {
    const id =
      handle && typeof handle === 'object' && Symbol.toPrimitive in handle
        ? handle[Symbol.toPrimitive]()
        : handle;
    const state = byId.get(id);
    if (state) {
      byId.delete(id);
      handles.delete(state);
    }
    nativeClear(id);
  };

  return {
    setTimeout: (fn, delay, ...args) => {
      if (typeof fn !== 'function') return nativeSetTimeout(fn, delay, ...args);
      return makeTimeout(fn, delay, args, false);
    },
    clearTimeout: (handle) => clear(handle, nativeClearTimeout),
    setInterval: (fn, delay, ...args) => {
      if (typeof fn !== 'function') return nativeSetInterval(fn, delay, ...args);
      return makeTimeout(fn, delay, args, true);
    },
    clearInterval: (handle) => clear(handle, nativeClearInterval),
    clearPending() {
      for (const [id, state] of byId) {
        if (state.repeating) nativeClearInterval(id);
        else nativeClearTimeout(id);
        handles.delete(state);
      }
      byId.clear();
      handles.notify();
    },
  };
}
