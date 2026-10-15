/**
 * Node 22's BroadcastChannel (lib/internal/worker/io.js), in-process: the
 * channels of one name talk among themselves within this program, as
 * Node's do among the threads of one process (jsh has one thread). It never
 * touches the platform's BroadcastChannel, which the kernel withholds on
 * purpose (it would reach other contexts of the origin); jsh installs this
 * one only where the kernel leaves the global slot writable (slicc-kernel
 * 1.92.0, #565).
 *
 * A message is structuredClone'd when it's posted and delivered on a later
 * turn, as a MessageEvent, to every other open channel of its name, in the
 * order they were made. An open, ref'd channel keeps the program alive.
 */
import { nodeError } from '../node-errors.mjs';

const kInspect = Symbol.for('nodejs.util.inspect.custom');

export function createBroadcastChannel({ handles, schedule }) {
  /** @type {Map<string, Set<BroadcastChannel>>} */
  const channels = new Map();
  const later = schedule ?? ((fn) => setTimeout(fn, 0));
  // What each channel has yet to receive. Node's channels are message ports:
  // on a turn, each port (in the order the channels were made) takes all it
  // has, so a channel made first gets its messages first.
  const inbox = new Map();
  let created = 0;
  let flushing = null;
  const flushSoon = () => {
    if (flushing) return;
    // Hold the program until the messages are delivered, as queued port messages do.
    flushing = { kind: 'broadcast-message' };
    handles?.add(flushing);
    // One message per task, so the microtasks a handler queues run before
    // the next message, as Node's per-message checkpoint has it.
    const step = (due, i) => {
      if (i < due.length) {
        const [ch, data] = due[i];
        ch._deliver(data);
        handles?.notify?.();
        later(() => step(due, i + 1));
        return;
      }
      if (inbox.size > 0) {
        later(() => step(takeDue(), 0));
        return;
      }
      handles?.delete(flushing);
      flushing = null;
      handles?.notify?.();
    };
    later(() => step(takeDue(), 0));
  };
  const takeDue = () => {
    const due = [];
    for (const [ch, messages] of [...inbox.entries()].sort(([x], [y]) => x._order - y._order)) {
      for (const data of messages) due.push([ch, data]);
    }
    inbox.clear();
    return due;
  };

  class BroadcastChannel extends EventTarget {
    #name;
    #open = true;
    #handle = { kind: 'broadcast-channel' };
    #refed = true;
    #onmessage = null;
    #onmessageerror = null;

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
      const targets = [...(channels.get(this.#name) ?? [])].filter((ch) => ch !== this);
      if (targets.length === 0) return;
      for (const ch of targets) {
        let q = inbox.get(ch);
        if (!q) inbox.set(ch, (q = []));
        q.push(data);
      }
      flushSoon();
    }

    /** @internal Each receiver gets its own copy, as each port deserializes its own. */
    _deliver(data) {
      if (!this.#open) return;
      let copy;
      try {
        copy = structuredClone(data);
      } catch {
        this.dispatchEvent(new MessageEvent('messageerror'));
        return;
      }
      this.dispatchEvent(new MessageEvent('message', { data: copy }));
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
  return BroadcastChannel;
}
