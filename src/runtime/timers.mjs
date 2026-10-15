/**
 * setTimeout / setInterval / setImmediate with Node's Timeout / Immediate
 * ref()/unref() and handle counting. User callbacks run as Timeout._onTimeout
 * or Immediate._onImmediate so uncaught stacks match Node.
 */

function Timeout() {}
function Immediate() {}

export function createTimers(handles, { onCallbackError, afterCallback, hold = () => false } = {}) {
  // hold(due): whether a timeout that became due at `due` must wait (one
  // task at a time) for what runs before it: the BroadcastChannel batch being
  // delivered, for a timeout that became due after the batch started.
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const nativeSetInterval = globalThis.setInterval.bind(globalThis);
  const nativeClearInterval = globalThis.clearInterval.bind(globalThis);

  const byId = new Map();
  // Once the program is ending (process.exit(), a fatal error) no timer of
  // the program fires. Timers set after that are the kernel's own (it ends
  // the process on a timer) or the unwinding script's: they go straight to
  // the platform, untracked, so stopping can never cancel the kernel's.
  let stopped = false;
  // process.domain where lib/domain.js is loaded (it defines the property).
  const currentDomain = () => globalThis.process?.domain ?? undefined;
  const domainActive = () => globalThis.process?.domain ?? undefined;

  const runMethod = (handle, method, args, domain) => {
    // The domain the timer was made in (lib/domain.js), entered around its
    // callback as Node's async hooks do: a throw is that domain's error
    // (its handler leaves it); a return leaves it here.
    domain?.enter();
    try {
      handle[method](...args);
      domain?.exit();
    } catch (err) {
      if (onCallbackError) onCallbackError(err);
      else throw err;
    } finally {
      if (domain && domainActive() === domain) domain.exit();
    }
    // Node: the ticks a callback queued run right after it, before its
    // promise jobs (processTicksAndRejections after each timer / immediate).
    try {
      if (!stopped) afterCallback?.();
    } catch (err) {
      if (onCallbackError) onCallbackError(err);
      else throw err;
    } finally {
      handles.notify();
    }
  };

  const attachRefApi = (handle, state) => {
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
  };

  const makeTimeout = (fn, delay, args, repeating) => {
    if (stopped) {
      return repeating ? nativeSetInterval(fn, delay, ...args) : nativeSetTimeout(fn, delay, ...args);
    }
    const state = {
      kind: 'Timeout',
      refed: true,
      id: null,
      retry: null,
      repeating,
    };
    const handle = new Timeout();
    handle._onTimeout = fn;
    attachRefApi(handle, state);
    const domain = currentDomain();

    const retry = () => {
      state.retry = null;
      fire();
    };
    const fire = () => {
      if (stopped) return;
      if (hold(state.due)) {
        state.retry ??= nativeSetTimeout(retry, 0);
        return;
      }
      if (state.retry) {
        nativeClearTimeout(state.retry);
        state.retry = null;
      }
      if (!state.repeating) {
        byId.delete(state.id);
        handles.delete(state);
      } else {
        // As Node reschedules an interval: from when its callback starts.
        state.due = Date.now() + state.delay;
      }
      runMethod(handle, '_onTimeout', args, domain);
    };
    // Node's delay: a number from 1 up (anything else is 1).
    state.delay = delay >= 1 && delay <= 2147483647 ? Number(delay) : 1;
    state.due = Date.now() + state.delay;
    state.id = repeating ? nativeSetInterval(fire, delay ?? 0) : nativeSetTimeout(fire, delay ?? 0);
    byId.set(state.id, state);
    handles.add(state);
    return handle;
  };

  const makeImmediate = (fn, args) => {
    if (stopped) return nativeSetTimeout(fn, 0, ...args);
    const state = {
      kind: 'Immediate',
      refed: true,
      id: null,
      repeating: false,
    };
    const handle = new Immediate();
    handle._onImmediate = fn;
    attachRefApi(handle, state);
    const domain = currentDomain();

    const fire = () => {
      if (stopped) return;
      byId.delete(state.id);
      handles.delete(state);
      runMethod(handle, '_onImmediate', args, domain);
    };
    state.id = nativeSetTimeout(fire, 0);
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
      if (state.retry) nativeClearTimeout(state.retry);
    }
    nativeClear(id);
  };

  return {
    /** A tracked timeout or interval is due now and has not run yet. */
    overdue() {
      const now = Date.now();
      for (const state of byId.values()) {
        if (state.kind === 'Timeout' && state.due <= now) return true;
      }
      return false;
    },
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
    setImmediate: (fn, ...args) => {
      if (typeof fn !== 'function') return nativeSetTimeout(fn, 0, ...args);
      return makeImmediate(fn, args);
    },
    clearImmediate: (handle) => clear(handle, nativeClearTimeout),
    clearPending() {
      for (const [id, state] of byId) {
        if (state.retry) nativeClearTimeout(state.retry);
        if (state.repeating) nativeClearInterval(id);
        else nativeClearTimeout(id);
        handles.delete(state);
      }
      byId.clear();
      handles.notify();
    },
    /** The program is ending: clear its timers; later ones bypass the table. */
    stop() {
      stopped = true;
      this.clearPending();
    },
  };
}
