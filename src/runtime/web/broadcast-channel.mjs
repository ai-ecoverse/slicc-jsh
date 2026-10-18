/**
 * Node 22's message ports, in-process (lib/internal/worker/io.js): the
 * BroadcastChannel and the MessageChannel / MessagePort of this program,
 * which talk among themselves as Node's do among the threads of one process
 * (jsh has one thread). The platform's are never used: the kernel withholds
 * its BroadcastChannel on purpose (it would reach other contexts of the
 * origin), and its MessagePort delivers in its own order. jsh installs
 * BroadcastChannel only where the kernel leaves the global slot writable
 * (slicc-kernel 1.92.0, #565); worker_threads exports it on every kernel.
 *
 * Every port (a channel, a MessagePort) has its own queue. A message is
 * structuredClone'd when it's posted and delivered on a later turn, as a
 * MessageEvent. On a delivery turn each ready port, in the order the ports
 * were made, takes the messages it had when the turn started, one per task
 * (so a handler's microtasks and ticks run before the next message, Node's
 * checkpoint), as libuv drains each port's queue in one poll phase.
 *
 * Node's poll phase comes after its timers phase and before its check phase:
 * a turn waits while a timer is already due (`delivering.overdue`, from the
 * timers); once it starts (`delivering.active`, `delivering.since`) the
 * timers hold the program's immediates, and each timeout that becomes due
 * after the start, until the turn is done; such a timeout then also waits
 * for the immediates pending when the turn ended (`delivering.endTurn`:
 * Node's check phase comes before its next timers phase, however long the
 * handlers took). `schedule` is the timers' own immediate, which isn't
 * held. Messages posted during a turn make the next one.
 */
import { nodeError } from '../node-errors.mjs';

const kInspect = Symbol.for('nodejs.util.inspect.custom');
const kCreate = Symbol('MessagePort');
const kPortMark = '\u0000slicc-jsh port';

export function createPorts({
  handles,
  schedule,
  delivering = { active: false, pending: false, since: 0, overdue: () => false, inCheck: () => false, endTurn: () => {} },
}) {
  // A task in line with the program's immediates, never held itself: whether
  // the immediates queued before it run first is `delivering.pending`'s call.
  const later = schedule ?? ((fn) => setTimeout(fn, 0));
  /** Ports with messages to deliver (or a close to dispatch). */
  const ready = new Set();
  let created = 0;
  let flushing = null;

  // The ports this turn still visits (in the order they were made), the one
  // being visited and how many of its messages it takes, and the ports
  // whose 'close' is due at the turn's end.
  let turn = [];
  let current = null;
  let left = 0;
  let closes = [];
  const byOrder = (x, y) => x._order - y._order;
  const flushSoon = () => {
    if (flushing) return;
    // Hold the program until the messages are delivered, as queued port messages do.
    flushing = { kind: 'port-message' };
    handles?.add(flushing);
    // Node checks its timers when an iteration starts, before the poll phase:
    // a timer that was due when the posting task ended runs first, one
    // that became due while the messages waited for their turn doesn't.
    let checkAt = Infinity;
    const step = (first) => {
      if (first && delivering.overdue?.(Math.min(checkAt, Date.now()))) {
        later(() => step(true));
        return;
      }
      // The turn starts when the posting task ended, not when this task got
      // to run: a timeout due in between waits for it too.
      const startedAt = Math.min(checkAt, Date.now());
      checkAt = Infinity;
      delivering.pending = false;
      if (first) {
        turn = [...ready].sort(byOrder);
        ready.clear();
        closes = [];
        current = null;
        delivering.active = turn.length > 0;
        delivering.since = startedAt;
      }
      for (;;) {
        if (current && left > 0) {
          left -= 1;
          if (!current._deliverNext()) continue;
          handles?.notify?.();
          later(() => step(false));
          return;
        }
        if (current?._closeDue?.()) closes.push(current);
        current = turn.shift() ?? null;
        if (current) {
          left = current._pending();
          continue;
        }
        const port = closes.shift();
        if (!port) break;
        if (!port._dispatchClose()) continue;
        handles?.notify?.();
        later(() => step(false));
        return;
      }
      delivering.active = false;
      delivering.endTurn?.();
      if (ready.size > 0) {
        // Posted from a handler: Node's next iteration, after the immediates
        // (pending is false); from elsewhere (a timer, I/O): this poll phase.
        later(() => step(true));
        return;
      }
      handles?.delete(flushing);
      flushing = null;
      handles?.notify?.();
    };
    queueMicrotask(() => {
      checkAt = Date.now();
    });
    later(() => step(true));
  };
  // A post from the main program or a callback other than an immediate or
  // a port's handler: the immediates already queued wait for its turn
  // (Node's poll phase comes before its check phase). During a turn, a port
  // the turn has yet to reach takes it in this turn (libuv walks the ports
  // in order); one it has passed, in the next.
  const wake = (port) => {
    if (delivering.active) {
      const at = current?._order ?? -1;
      if (port !== current && port._order > at) {
        if (!turn.includes(port)) {
          turn.push(port);
          turn.sort(byOrder);
        }
        return;
      }
    } else if (!delivering.inCheck?.()) delivering.pending = true;
    ready.add(port);
    flushSoon();
  };

  // A transferred port goes by itself (one thread): out of the value before
  // the clone, back in after it; the rest of the transfer list is the clone's.
  const cloneFor = (message, transfer) => {
    const list = transfer === undefined || transfer === null ? [] : Array.isArray(transfer) ? transfer : (transfer?.transfer ?? []);
    const ports = [...list].filter((x) => x instanceof MessagePort);
    const rest = [...list].filter((x) => !(x instanceof MessagePort));
    const marks = new Map(ports.map((port, i) => [port, { [kPortMark]: i }]));
    const seen = new Set();
    const swap = (value, map) => {
      if (value === null || typeof value !== 'object' || seen.has(value)) return value;
      if (map.has(value)) return map.get(value);
      if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return value;
      seen.add(value);
      for (const key of Object.keys(value)) value[key] = swap(value[key], map);
      return value;
    };
    const restore = (value) => {
      if (value === null || typeof value !== 'object') return value;
      if (kPortMark in value) return ports[value[kPortMark]];
      if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return value;
      for (const key of Object.keys(value)) value[key] = restore(value[key]);
      return value;
    };
    if (ports.length === 0) return { data: structuredClone(message, rest.length ? { transfer: rest } : undefined), ports };
    const undo = new Map([...marks].map(([port, mark]) => [mark, port]));
    const marked = swap(message, marks);
    let data;
    try {
      data = structuredClone(marked, rest.length ? { transfer: rest } : undefined);
    } finally {
      seen.clear();
      swap(marked, undo);
    }
    return { data: restore(data), ports };
  };

  class BroadcastChannel extends EventTarget {
    #name;
    #open = true;
    #handle = { kind: 'broadcast-channel' };
    #refed = true;
    #onmessage = null;
    #onmessageerror = null;
    #queue = [];

    constructor(name) {
      if (arguments.length === 0) throw nodeError(TypeError, 'ERR_MISSING_ARGS', 'The "name" argument must be specified');
      super();
      this.#name = `${name}`;
      Object.defineProperty(this, '_order', { value: created++ });
      let set = channels.get(this.#name);
      if (!set) channels.set(this.#name, (set = new Set()));
      set.add(this);
      handles?.add(this.#handle);
    }

    get name() {
      return this.#name;
    }

    close() {
      if (!this.#open) return;
      this.#open = false;
      const set = channels.get(this.#name);
      set?.delete(this);
      if (set && set.size === 0) channels.delete(this.#name);
      handles?.delete(this.#handle);
    }

    postMessage(message) {
      if (!this.#open) throw new DOMException('BroadcastChannel is closed.', 'InvalidStateError');
      if (arguments.length === 0) throw nodeError(TypeError, 'ERR_MISSING_ARGS', 'The "message" argument must be specified');
      const data = structuredClone(message);
      for (const ch of channels.get(this.#name) ?? []) {
        if (ch === this) continue;
        ch._enqueue(data);
      }
    }

    /** @internal */
    _enqueue(data) {
      this.#queue.push(data);
      wake(this);
    }
    /** @internal */
    _pending() {
      return this.#queue.length;
    }
    /** @internal Each receiver gets its own copy, as each port deserializes its own. */
    _deliverNext() {
      if (this.#queue.length === 0) return false;
      const data = this.#queue.shift();
      if (!this.#open) return false;
      let copy;
      try {
        copy = structuredClone(data);
      } catch {
        this.dispatchEvent(new MessageEvent('messageerror'));
        return true;
      }
      this.dispatchEvent(new MessageEvent('message', { data: copy }));
      return true;
    }

    ref() {
      if (this.#open && !this.#refed) handles?.add(this.#handle);
      this.#refed = true;
      return this;
    }

    unref() {
      if (this.#refed) handles?.delete(this.#handle);
      this.#refed = false;
      return this;
    }

    get onmessage() {
      return this.#onmessage;
    }
    set onmessage(fn) {
      if (this.#onmessage) this.removeEventListener('message', this.#onmessage);
      this.#onmessage = typeof fn === 'function' ? fn : null;
      if (this.#onmessage) this.addEventListener('message', this.#onmessage);
    }
    get onmessageerror() {
      return this.#onmessageerror;
    }
    set onmessageerror(fn) {
      if (this.#onmessageerror) this.removeEventListener('messageerror', this.#onmessageerror);
      this.#onmessageerror = typeof fn === 'function' ? fn : null;
      if (this.#onmessageerror) this.addEventListener('messageerror', this.#onmessageerror);
    }

    [kInspect](depth, options, inspect) {
      if (depth < 0) return 'BroadcastChannel';
      const opts = { ...options, depth: options.depth == null ? null : options.depth - 1 };
      return `BroadcastChannel ${inspect({ name: this.#name, active: this.#open }, opts)}`;
    }
  }
  /** @type {Map<string, Set<BroadcastChannel>>} */
  const channels = new Map();

  /**
   * Node's MessagePort: a NodeEventTarget. Its first 'message' listener
   * (onmessage, on(), addEventListener()) starts it and refs it, the last
   * one gone unrefs it; messages wait in its queue until it's started.
   * close() closes both ends: what was posted before is still delivered,
   * then each end gets 'close'.
   */
  class MessagePort extends EventTarget {
    #peer = null;
    // Its other end in another thread (./remote-ports.mjs): `post(message,
    // transfer)` and `close()` go there instead of to #peer.
    #link = null;
    // Moved to another thread: it takes and delivers nothing more.
    #detached = false;
    #open = true;
    #started = false;
    #refed = false;
    #handle = { kind: 'message-port' };
    #queue = [];
    #closeDue = false;
    #count = 0;
    #registered = new Map();
    #onmessage = null;
    #onmessageerror = null;

    constructor(token) {
      if (token !== kCreate) throw nodeError(TypeError, 'ERR_CONSTRUCT_CALL_INVALID', 'Constructor cannot be called');
      super();
      Object.defineProperty(this, '_order', { value: created++ });
    }

    /** @internal */
    static _pair() {
      const a = new MessagePort(kCreate);
      const b = new MessagePort(kCreate);
      a.#peer = b;
      b.#peer = a;
      return [a, b];
    }

    postMessage(message, transfer) {
      if (arguments.length === 0) {
        throw nodeError(TypeError, 'ERR_MISSING_ARGS', 'Not enough arguments to MessagePort.postMessage');
      }
      if (this.#link) {
        if (this.#open) this.#link.post(message, transfer);
        return;
      }
      const entry = cloneFor(message, transfer);
      const peer = this.#peer;
      if (!this.#open || !peer) return;
      peer.#queue.push(entry);
      if (peer.#started) wake(peer);
    }

    start() {
      if (this.#started || !this.#open) return;
      this.#started = true;
      if (this.#queue.length > 0) wake(this);
    }

    close() {
      if (!this.#open) return;
      if (this.#link) {
        const link = this.#link;
        this._remoteClosed();
        link.close();
        return;
      }
      for (const port of [this, this.#peer].filter(Boolean)) {
        port.#open = false;
        port.#closeDue = true;
        if (!port.#started) port.#queue.length = 0;
        wake(port);
      }
    }

    ref() {
      this.#setRef(true);
      return this;
    }
    unref() {
      this.#setRef(false);
      return this;
    }
    hasRef() {
      return this.#refed;
    }
    #setRef(on) {
      const want = on && (this.#open || this.#closeDue);
      if (want === this.#refed) return;
      this.#refed = want;
      if (want) handles?.add(this.#handle);
      else handles?.delete(this.#handle);
    }

    /** @internal The other end is now in another thread, reached by `link`. */
    _attachLink(link) {
      this.#link = link;
      this.#peer = null;
    }
    /** @internal Its link to another thread, if its other end is there. */
    _remote() {
      return this.#link;
    }
    /** @internal This port's other end, when it is in this thread. */
    _localPeer() {
      return this.#link ? null : this.#peer;
    }
    /** @internal A message from the other thread. */
    _enqueue(entry) {
      if (!this.#open || this.#detached) return;
      this.#queue.push(entry);
      if (this.#started) wake(this);
    }
    /** @internal The other end closed (or went with its thread). */
    _remoteClosed() {
      if (!this.#open) return;
      this.#open = false;
      this.#closeDue = true;
      if (!this.#started) this.#queue.length = 0;
      wake(this);
    }
    /**
     * @internal This port goes to another thread: what it holds (its queue,
     * whether it is closed) goes with it, and it does nothing more here.
     */
    _detach() {
      const queue = this.#queue.splice(0);
      const link = this.#link;
      const open = this.#open;
      this.#detached = true;
      this.#open = false;
      this.#link = null;
      this.#setRef(false);
      return { queue, link, open };
    }
    get _detached() {
      return this.#detached;
    }
    /** @internal */
    _pending() {
      return this.#started ? this.#queue.length : 0;
    }
    /** @internal Its 'close', once what came before it is delivered. */
    _closeDue() {
      return this.#closeDue && !(this.#started && this.#queue.length > 0);
    }
    /** @internal */
    _dispatchClose() {
      if (!this._closeDue()) return false;
      this.#closeDue = false;
      this.#queue.length = 0;
      this.#setRef(false);
      this.dispatchEvent(new Event('close'));
      return true;
    }
    /** @internal */
    _deliverNext() {
      if (this.#detached) return false;
      if (this.#started && this.#queue.length > 0) {
        const { data, ports } = this.#queue.shift();
        // The last before a due close: the close's turn comes next.
        if (this.#queue.length === 0 && this.#closeDue) wake(this);
        // The platform's MessageEvent takes only its own ports: these go on as `ports`.
        const event = new MessageEvent('message', { data });
        const list = Object.freeze([...ports]);
        Object.defineProperty(event, 'ports', { get: () => list, enumerable: true, configurable: true });
        this.dispatchEvent(event);
        return true;
      }
      return false;
    }
    /** @internal worker_threads.receiveMessageOnPort */
    _receive() {
      // What its other thread wrote to it is here at once (its mailbox).
      this.#link?.pull?.();
      const entry = this.#queue.shift();
      return entry === undefined ? undefined : { message: entry.data };
    }

    addEventListener(type, listener, options) {
      super.addEventListener(type, listener, options);
      if (type !== 'message' || !listener) return;
      const capture = typeof options === 'boolean' ? options : !!options?.capture;
      let modes = this.#registered.get(listener);
      if (!modes) this.#registered.set(listener, (modes = new Set()));
      if (modes.has(capture)) return;
      modes.add(capture);
      if (this.#count++ === 0) {
        this.#setRef(true);
        this.start();
      }
    }
    removeEventListener(type, listener, options) {
      super.removeEventListener(type, listener, options);
      if (type !== 'message' || !listener) return;
      const capture = typeof options === 'boolean' ? options : !!options?.capture;
      const modes = this.#registered.get(listener);
      if (!modes?.delete(capture)) return;
      if (modes.size === 0) this.#registered.delete(listener);
      if (--this.#count === 0) this.#setRef(false);
    }

    // NodeEventTarget's emitter methods: a 'message' listener gets the data.
    #emitters = new Map();
    on(type, listener, original = listener) {
      const fn = (event) => listener.call(this, type === 'message' || type === 'messageerror' ? event.data : event);
      let list = this.#emitters.get(type);
      if (!list) this.#emitters.set(type, (list = []));
      list.push([original, fn, listener]);
      this.addEventListener(type, fn);
      return this;
    }
    addListener(type, listener) {
      return this.on(type, listener);
    }
    once(type, listener) {
      const wrapper = (...args) => {
        this.off(type, listener);
        listener.apply(this, args);
      };
      return this.on(type, wrapper, listener);
    }
    off(type, listener) {
      const list = this.#emitters.get(type);
      const i = list?.findIndex(([l]) => l === listener) ?? -1;
      if (i !== -1) {
        const [[, fn]] = list.splice(i, 1);
        this.removeEventListener(type, fn);
      }
      return this;
    }
    removeListener(type, listener) {
      return this.off(type, listener);
    }
    removeAllListeners(type) {
      for (const name of type === undefined ? [...this.#emitters.keys()] : [type]) {
        for (const [listener] of [...(this.#emitters.get(name) ?? [])]) this.off(name, listener);
      }
      return this;
    }
    listenerCount(type) {
      return this.#emitters.get(type)?.length ?? 0;
    }
    eventNames() {
      return [...this.#emitters.keys()].filter((name) => this.#emitters.get(name).length > 0);
    }
    emit(type, arg) {
      const list = this.#emitters.get(type) ?? [];
      for (const [, , listener] of [...list]) listener.call(this, arg);
      return list.length > 0;
    }
    setMaxListeners() {
      return this;
    }
    getMaxListeners() {
      return 10;
    }

    get onmessage() {
      return this.#onmessage;
    }
    set onmessage(fn) {
      if (this.#onmessage) this.removeEventListener('message', this.#onmessage);
      this.#onmessage = typeof fn === 'function' ? fn : null;
      if (this.#onmessage) this.addEventListener('message', this.#onmessage);
    }
    get onmessageerror() {
      return this.#onmessageerror;
    }
    set onmessageerror(fn) {
      if (this.#onmessageerror) this.removeEventListener('messageerror', this.#onmessageerror);
      this.#onmessageerror = typeof fn === 'function' ? fn : null;
      if (this.#onmessageerror) this.addEventListener('messageerror', this.#onmessageerror);
    }

    [kInspect](depth, options, inspect) {
      if (depth < 0) return '[MessagePort [EventTarget]]';
      const opts = { ...options, depth: options.depth == null ? null : options.depth - 1 };
      return `MessagePort [EventTarget] ${inspect({ active: this.#open, refed: this.#refed }, opts)}`;
    }
  }

  class MessageChannel {
    constructor() {
      const [port1, port2] = MessagePort._pair();
      this.port1 = port1;
      this.port2 = port2;
    }
  }

  const receiveMessageOnPort = (port) => {
    if (!(port instanceof MessagePort)) {
      throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "port" argument must be a MessagePort instance');
    }
    return port._receive();
  };

  /** @internal An unpaired port, for one that comes from another thread. */
  const makePort = () => new MessagePort(kCreate);

  return { BroadcastChannel, MessageChannel, MessagePort, receiveMessageOnPort, makePort, kPortMark };
}

export function createBroadcastChannel(options) {
  return createPorts(options).BroadcastChannel;
}
