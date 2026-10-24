/**
 * setTimeout / setInterval / setImmediate with Node's Timeout / Immediate
 * ref()/unref() and handle counting. User callbacks run as Timeout._onTimeout
 * or Immediate._onImmediate so uncaught stacks match Node.
 */

import { currentFrame, runInFrame } from './async-context.mjs';
import { createMinHeap } from './min-heap.mjs';

function Timeout() {}
function Immediate() {}

export function createTimers(
  handles,
  { onCallbackError, afterCallback, hold = () => false, holdImmediate = () => false } = {}
) {
  // hold(due): whether a timeout that became due at `due` must wait (one
  // task at a time) for what runs before it: the message ports' turn being
  // delivered, for a timeout that became due after the turn started.
  // holdImmediate(seq): whether the program's immediate made `seq`th must
  // wait (Node's check phase comes after the poll phase that delivers port
  // messages).
  let checkPhase = false;
  let closePhaseRan = false;
  let closeDepth = 0;
  let checkCut = 0;
  let checkGen = 0;
  let timerAt = null;
  const endPhase = () => {
    if (closeDepth > 0) return;
    checkPhase = false;
    closePhaseRan = false;
    timerAt = null;
  };
  const runClose = ({ fn, frame }) => {
    endPhase();
    closePhaseRan = true;
    closeDepth++;
    try {
      runInFrame(frame, fn, undefined, []);
      afterCallback?.();
    } catch (err) {
      if (onCallbackError) onCallbackError(err);
      else throw err;
    } finally {
      closeDepth--;
    }
  };
  const atIdle = [];
  // The check phase that follows a message ports' turn (Node runs the
  // immediates queued by the end of the poll phase before its next timers
  // phase): the immediates pending when the turn ended. While any of them
  // is still to run, a timeout that became due during the turn waits.
  const check = new Set();
  // The timeouts hold() keeps waiting, each on a retry of its own. The
  // first to find the hold over runs them all, in the order of Node's
  // timers phase, not in the order the platform runs their retries (the
  // turn's own steps come between those). Node keeps a list per delay, in
  // the order the timers were set; it takes the lists by when their first
  // timer is due (on a tie, the older list first), and runs each list's due
  // timers before the next list's.
  const held = new Set();
  const nodeOrder = (timers) => {
    const lists = new Map();
    for (const t of timers) {
      const list = lists.get(t.delay) ?? { due: Infinity, seq: Infinity };
      lists.set(t.delay, { due: Math.min(list.due, t.due), seq: Math.min(list.seq, t.seq) });
    }
    const of = (t) => lists.get(t.delay);
    return timers.sort((x, y) => of(x).due - of(y).due || of(x).seq - of(y).seq || x.seq - y.seq);
  };
  let made = 0;
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
  // While the loop makes sure no promise job is left before it ends (its
  // final drain), no timer or immediate runs: those that come due wait, and
  // run only if the program goes on (thaw()). Node's loop ends with an
  // unref'd one never run.
  let frozen = false;
  // What came due meanwhile: fire → its due time (an immediate's is Infinity:
  // the check phase comes after the timers').
  const due = new Map();
  // process.domain where lib/domain.js is loaded (it defines the property).
  const currentDomain = () => globalThis.process?.domain ?? undefined;
  const domainActive = () => globalThis.process?.domain ?? undefined;

  const runMethod = (handle, method, args, domain, frame = null) => {
    // The domain the timer was made in (lib/domain.js), entered around its
    // callback as Node's async hooks do: a throw is that domain's error
    // (its handler leaves it); a return leaves it here.
    domain?.enter();
    try {
      // The async context (AsyncLocalStorage's stores) it was made in.
      runInFrame(frame, handle[method], handle, args);
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
    const frame = currentFrame();

    const retry = () => {
      state.retry = null;
      fire();
    };
    const run = () => {
      held.delete(state);
      if (state.retry) {
        nativeClearTimeout(state.retry);
        state.retry = null;
      }
      if (!state.repeating) {
        byId.delete(state.id);
        handles.delete(state);
      } else {
        // As Node reschedules an interval: from when its callback starts,
        // at the end of its delay's list.
        state.due = Date.now() + state.delay;
        state.seq = made++;
        state.timers = checkGen + 2;
        indexTimeout(state);
      }
      checkPhase = false;
      closePhaseRan = false;
      timerAt = Date.now();
      runMethod(handle, '_onTimeout', args, domain, frame);
    };
    const fire = () => {
      if (stopped) return;
      if (frozen) {
        if (!due.has(fire)) due.set(fire, state.due);
        return;
      }
      if (closeTimer || hold(state.due) || (state.afterIo && immediatesFirst(state.timers))) {
        held.add(state);
        state.retry ??= nativeSetTimeout(retry, 0);
        return;
      }
      if (held.size === 0) return run();
      held.add(state);
      for (const next of nodeOrder([...held])) {
        if (stopped) return;
        // One an earlier callback cleared, or a later turn holds, waits.
        if (held.has(next) && (next === state || !hold(next.due))) next.run();
      }
    };
    state.run = run;
    state.afterIo = looping && !checkPhase && !closePhaseRan;
    state.timers = checkGen + (state.afterIo ? 2 : 1);
    state.seq = made++;
    // Node's delay: a number from 1 up (anything else is 1).
    state.delay = delay >= 1 && delay <= 2147483647 ? Number(delay) : 1;
    state.due = Date.now() + state.delay;
    state.id = repeating ? nativeSetInterval(fire, delay ?? 0) : nativeSetTimeout(fire, delay ?? 0);
    byId.set(state.id, state);
    indexTimeout(state);
    handles.add(state);
    return handle;
  };

  const makeImmediate = (fn, args, held = true, inCheck = held) => {
    if (stopped) return nativeSetTimeout(fn, 0, ...args);
    const state = {
      kind: 'Immediate',
      refed: true,
      id: null,
      retry: null,
      repeating: false,
      inCheck,
      nextCheck: inCheck && (checkPhase || closePhaseRan),
      check: checkGen + 1,
    };
    const handle = new Immediate();
    handle._onImmediate = fn;
    attachRefApi(handle, state);
    const domain = currentDomain();
    const frame = currentFrame();

    const fire = () => {
      if (stopped) return;
      if (frozen) {
        due.set(fire, Infinity);
        return;
      }
      if (held && (closeTimer || holdImmediate(state.seq) || (state.nextCheck && timersFirst(state.check)) || (inCheck && waitingBefore(state.seq)))) {
        state.retry = nativeSetTimeout(fire, 0);
        if (inCheck && !state.retrying) {
          state.retrying = true;
          retrying.push(state);
          bound(retrying, validRetry);
        }
        return;
      }
      state.retry = null;
      state.retrying = false;
      byId.delete(state.id);
      handles.delete(state);
      check.delete(state);
      endPhase();
      if (inCheck) {
        if (state.seq >= checkCut) checkCut = made;
        if (state.check > checkGen) advance(state.check);
        checkPhase = true;
      }
      try {
        runMethod(handle, '_onImmediate', args, domain, frame);
      } finally {
        if (closing.length > 0) scheduleClose();
      }
    };
    state.seq = made++;
    state.id = nativeSetTimeout(fire, 0);
    byId.set(state.id, state);
    if (inCheck) indexImmediate(pendingImmediates, state);
    handles.add(state);
    return handle;
  };

  const live = (state) => byId.get(state.id) === state;
  const pendingImmediates = createMinHeap((a, b) => a.seq < b.seq);
  const retrying = createMinHeap((a, b) => a.seq < b.seq);
  const validRetry = (state) => state.retrying && live(state);
  const bound = (heap, valid) => {
    if (heap.size > 16 + 2 * byId.size) heap.keep(valid);
  };
  const indexImmediate = (heap, state) => {
    heap.push(state);
    bound(heap, live);
  };
  const byDue = (a, b) => a.due < b.due;
  let pastTimeouts = createMinHeap(byDue);
  const nextTimeouts = new Map();
  const validTimeout = (entry) => live(entry.state) && entry.state.due === entry.due && entry.state.timers === entry.timers;
  const timeoutHeap = (timers) => {
    if (timers <= checkGen) return pastTimeouts;
    let heap = nextTimeouts.get(timers);
    if (!heap) nextTimeouts.set(timers, (heap = createMinHeap(byDue)));
    return heap;
  };
  const indexTimeout = (state) => {
    const heap = timeoutHeap(state.timers);
    heap.push({ state, due: state.due, timers: state.timers });
    bound(heap, validTimeout);
  };
  const advance = (gen) => {
    checkGen = gen;
    for (let [timers, heap] of nextTimeouts) {
      if (timers > gen) continue;
      nextTimeouts.delete(timers);
      if (heap.size > pastTimeouts.size) [heap, pastTimeouts] = [pastTimeouts, heap];
      for (const entry of heap.drain()) if (validTimeout(entry)) pastTimeouts.push(entry);
      bound(pastTimeouts, validTimeout);
    }
  };
  const firstImmediate = () => pendingImmediates.top(live);
  const pendingBefore = (cut) => {
    const first = firstImmediate();
    return first !== undefined && first.seq < cut;
  };
  const immediatesFirst = (timers) => {
    const first = firstImmediate();
    return first !== undefined && first.check < timers && !holdImmediate(first.seq);
  };
  const waitingBefore = (seq) => {
    const first = retrying.top(validRetry);
    return first !== undefined && first.seq < seq;
  };
  const timersFirst = (check) => {
    let first = pastTimeouts.top(validTimeout);
    for (const [timers, heap] of nextTimeouts) {
      if (timers > check) continue;
      const entry = heap.top(validTimeout);
      if (entry && (!first || entry.due < first.due)) first = entry;
    }
    return first !== undefined && first.due <= Date.now() && !hold(first.due);
  };
  let looping = false;
  const closing = [];
  let closeTimer = null;
  const closePhase = () => {
    closeTimer = null;
    for (let i = 0; i < closing.length; i++) {
      if (pendingBefore(closing[i].cut)) continue;
      const [entry] = closing.splice(i--, 1);
      runClose(entry);
    }
  };
  const scheduleClose = () => {
    if (closeTimer || !closing.some((entry) => !pendingBefore(entry.cut))) return;
    closeTimer = nativeSetTimeout(closePhase, 0);
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
      check.delete(state);
      held.delete(state);
      state.retrying = false;
      if (state.retry) nativeClearTimeout(state.retry);
      if (closing.length > 0) scheduleClose();
    }
    nativeClear(id);
  };

  return {
    /** A tracked timeout or interval was due at `now` and has not run yet. */
    overdue(now = Date.now()) {
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
    /** @internal An immediate that is never held (the message ports' own steps). */
    setImmediateUnheld: (fn) => makeImmediate(fn, [], false),
    setImmediatePoll: (fn) => makeImmediate(fn, [], true, false),
    /** @internal The entry has run: a timeout set from here on is set in the loop. */
    startLoop() {
      looping = true;
    },
    /** @internal Node's close phase: fn runs once the loop is idle, or after the immediates pending now have run. */
    afterCheck(fn, during = checkPhase) {
      const cut = during ? checkCut : made;
      const entry = { cut, fn, frame: currentFrame() };
      if (!pendingBefore(cut)) atIdle.push(entry);
      else closing.push(entry);
    },
    /** @internal The loop has run every tick and promise job it had: the close callbacks due now run. */
    idle() {
      endPhase();
      for (const entry of atIdle.splice(0)) runClose(entry);
    },
    /** @internal Whether one of the program's immediates, or its ticks and promise jobs, is running (Node's check phase). */
    inCheck: () => checkPhase,
    endPhase,
    checkCut: () => checkCut,
    timerAt: () => timerAt,
    immediatePending: (cut = Infinity) => pendingBefore(cut),
    /** @internal A message ports' turn ended: its check phase is the immediates pending now. */
    startCheck() {
      check.clear();
      for (const state of byId.values()) if (state.kind === 'Immediate' && state.inCheck) check.add(state);
    },
    /** @internal Whether the check phase after a ports' turn still has immediates to run. */
    checkPending: () => check.size > 0,
    clearPending() {
      for (const [id, state] of byId) {
        if (state.retry) nativeClearTimeout(state.retry);
        if (state.repeating) nativeClearInterval(id);
        else nativeClearTimeout(id);
        handles.delete(state);
      }
      byId.clear();
      held.clear();
      pendingImmediates.drain();
      retrying.drain();
      pastTimeouts = createMinHeap(byDue);
      nextTimeouts.clear();
      handles.notify();
    },
    /** @internal The loop's final drain: no timer or immediate runs. */
    freeze() {
      frozen = true;
    },
    /** @internal The program goes on: what came due runs. */
    thaw() {
      frozen = false;
      // In Node's order: the timers by when they came due, then the immediates.
      const fires = [...due].sort((a, b) => a[1] - b[1]).map(([fire]) => fire);
      due.clear();
      for (const fire of fires) nativeSetTimeout(fire, 0);
    },
    /** The program is ending: clear its timers; later ones bypass the table. */
    stop() {
      stopped = true;
      this.clearPending();
    },
  };
}
