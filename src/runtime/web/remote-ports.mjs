/**
 * MessagePorts across threads (worker_threads on a kernel with JS threads,
 * ai-ecoverse/slicc-kernel#1094). A jsh port whose other end is in another
 * thread talks to it over the platform's own MessagePort, whose structured
 * clone shares a SharedArrayBuffer and moves an ArrayBuffer or a native
 * port, as Node's does between its threads. The jsh port keeps its own
 * queue and turns (./broadcast-channel.mjs).
 *
 * Each direction also has a mailbox in shared memory (./mailbox.mjs): a
 * message with nothing to transfer goes there, as its V8 serialization
 * (the structured clone's own algorithm), so the receiving thread has it at
 * once, for receiveMessageOnPort() even while it never returns to its event
 * loop. Its ArrayBuffers in the transfer list are copied there and detached
 * here, which a program can't tell from a move. A message the mailbox can't
 * take (one transferring ports, or with SharedArrayBuffers in it) goes on
 * the native port. Every message has the sender's next number, and the receiver hands
 * them to its port in that order, whichever way they came.
 *
 * A jsh port in a message (in its transfer list) goes as the end of a native
 * channel, with its mailboxes, its numbering, the messages it had waiting,
 * and whether it was closed. If its other end is in this thread, that end
 * now talks over the channel's other end.
 *
 * On the native port: { t: 'm', seq, data, ports } for a message (its jsh
 * ports marked in `data`, as the in-thread clone marks them), { t: 'c', seq }
 * for a close. Anything else is the thread's own (a worker's 'online', its
 * output, …), for `onOther`.
 */
import { createMailbox, mailboxReader, mailboxWriter } from './mailbox.mjs';

const CLOSE = Symbol('close');
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const isArrayBuffer = (value) => {
  try {
    Reflect.apply(arrayBufferByteLength, value, []);
    return true;
  } catch {
    return false;
  }
};
const CHANNEL_MAILBOX = 256 * 1024;

/**
 * V8's checks of a transfer list, made before anything is sent or any port
 * exported, with its errors: a duplicate, or an ArrayBuffer already gone.
 */
function checkTransferList(list) {
  const seen = new Set();
  for (const item of list) {
    if (seen.has(item)) {
      const kind = isArrayBuffer(item) ? 'ArrayBuffer' : 'MessagePort';
      throw new DOMException(`Transfer list contains duplicate ${kind}`, 'DataCloneError');
    }
    seen.add(item);
    if (isArrayBuffer(item) && item.detached) throw new DOMException('Cannot transfer object of unsupported type.', 'DataCloneError');
  }
}

export function createRemotePorts({ ports, NativeMessageChannel, serdes }) {
  const { MessagePort, makePort, kPortMark } = ports;

  const transferListOf = (transfer) =>
    transfer === undefined || transfer === null ? [] : Array.isArray(transfer) ? transfer : [...(transfer?.transfer ?? [])];

  // A copy of a value with each of its jsh ports swapped (`swap(port)`) for
  // a mark, or the other way, through what structured clone goes into:
  // plain objects, arrays, Maps (keys too) and Sets. Shared and circular
  // parts stay shared. The value itself is left as it was.
  function mapPorts(value, swap, seen = new Map()) {
    if (value === null || typeof value !== 'object') return value;
    const swapped = swap(value);
    if (swapped !== undefined) return swapped;
    if (seen.has(value)) return seen.get(value);
    if (value instanceof Map) {
      const out = new Map();
      seen.set(value, out);
      for (const [k, v] of value) out.set(mapPorts(k, swap, seen), mapPorts(v, swap, seen));
      return out;
    }
    if (value instanceof Set) {
      const out = new Set();
      seen.set(value, out);
      for (const v of value) out.add(mapPorts(v, swap, seen));
      return out;
    }
    if (value instanceof Error) {
      // Structured clone keeps an Error's message, stack and cause: a port in
      // its cause is swapped in a copy of the same kind.
      if (!Object.hasOwn(value, 'cause')) return value;
      const out = new Error(value.message);
      Object.setPrototypeOf(out, Object.getPrototypeOf(value));
      seen.set(value, out);
      if (Object.hasOwn(value, 'stack')) out.stack = value.stack;
      out.cause = mapPorts(value.cause, swap, seen);
      return out;
    }
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value;
    const out = Array.isArray(value) ? new Array(value.length) : {};
    seen.set(value, out);
    for (const key of Object.keys(value)) out[key] = mapPorts(value[key], swap, seen);
    return out;
  }
  const swapPorts = (value, marks) => mapPorts(value, (v) => marks.get(v));
  const restorePorts = (value, list) =>
    mapPorts(value, (v) => (kPortMark in v && typeof v[kPortMark] === 'number' ? list[v[kPortMark]] : undefined));

  /**
   * `message` and its transfer list as the platform can clone them: the
   * message (its jsh ports marked) and the native transfer list, for `fn`,
   * which must clone at once (postMessage does); the value is unmarked after.
   */
  function pack(message, transfer, fn) {
    const list = transferListOf(transfer);
    const jshPorts = list.filter((x) => x instanceof MessagePort);
    const rest = list.filter((x) => !(x instanceof MessagePort));
    for (const port of jshPorts) {
      if (port._detached) throw new DOMException('MessagePort in transfer list is already detached', 'DataCloneError');
    }
    checkTransferList(list);
    if (jshPorts.length === 0) return fn({ data: message, ports: [] }, rest);
    const marks = new Map(jshPorts.map((port, i) => [port, { [kPortMark]: i }]));
    const marked = swapPorts(message, marks);
    // What can't be cloned (a function) fails here, before any port is
    // exported: they stay this side's, usable, as in Node.
    structuredClone(marked);
    const natives = [];
    const envelopes = jshPorts.map((port) => exportPort(port, natives));
    return fn({ data: marked, ports: envelopes }, [...natives, ...rest]);
  }

  function receive(message) {
    const list = (message.ports ?? []).map(importPort);
    return { data: list.length ? restorePorts(message.data, list) : message.data, ports: list };
  }

  /** A pair of mailboxes, as the two ends of a link see them. */
  function mailboxPair(size) {
    const ab = createMailbox(size);
    const ba = createMailbox(size);
    return [
      { send: ab, receive: ba },
      { send: ba, receive: ab },
    ];
  }

  /**
   * Make `port` (a jsh port) the end of `native`. `box` is its mailboxes
   * ({ send, receive }), `state` the numbering it continues (a port that
   * moved), `onOther` where a message that isn't a port's goes (a worker's
   * own, on its thread's port; that port then stays open when this one
   * closes).
   */
  function link(port, native, onOther, box, state = {}) {
    const writer = box ? mailboxWriter(box.send) : null;
    const reader = box ? mailboxReader(box.receive) : null;
    let nextSend = state.nextSend ?? 0;
    let expect = state.expect ?? 0;
    const stash = new Map(state.stash ?? []);
    let ended = false;

    const end = () => {
      ended = true;
      if (!onOther) {
        native.onmessage = null;
        native.close();
      }
    };
    // Hand the port what has come, in its numbers' order.
    const deliver = (seq, entry) => {
      stash.set(seq, entry);
      while (stash.has(expect)) {
        const next = stash.get(expect);
        stash.delete(expect);
        expect += 1;
        if (next === CLOSE) {
          end();
          port._remoteClosed();
          return;
        }
        port._enqueue(next);
      }
    };
    const pull = () => {
      if (!reader || ended) return;
      for (const [seq, bytes] of reader.take()) deliver(seq, { data: serdes().deserialize(bytes), ports: [] });
    };
    // Mailbox messages wake the event loop as native ones do. The count is
    // read before taking what is there, so a record written in between
    // ends the wait at once.
    const watch = () => {
      if (!reader || ended) return;
      const seen = reader.count();
      pull();
      const wait = reader.waitAfter(seen);
      if (wait) wait.then(watch);
    };

    const remote = {
      native,
      box,
      pull,
      // A message's number is taken once it is sent: one that can't be
      // (a DataCloneError) leaves no gap for the other side to wait on.
      post(message, transfer) {
        const seq = nextSend;
        const list = transferListOf(transfer);
        // Nothing to transfer but ArrayBuffers: the mailbox, the buffers'
        // bytes copied and theirs detached (a move, as a program sees it).
        if (writer && list.every(isArrayBuffer)) {
          // V8's checks of a transfer list, before the message is out.
          checkTransferList(list);
          let bytes;
          try {
            bytes = serdes().serialize(message);
          } catch (err) {
            // What jsh's serializer can't write (a host object) goes the
            // native way; anything else (a getter's own throw) is the post's.
            if (err?.name !== 'DataCloneError') throw err;
            bytes = null;
          }
          if (bytes && writer.write(seq, bytes)) {
            nextSend++;
            // A buffer the message's getters detached meanwhile is gone
            // already: the rest move, and the post stands, as in Node.
            const live = list.filter((b) => !b.detached);
            if (live.length) structuredClone(live, { transfer: live });
            return;
          }
        }
        pack(message, transfer, (packed, natives) => {
          native.postMessage({ t: 'm', seq, ...packed }, natives);
          nextSend++;
        });
      },
      // A message packed and cloned before (with its transfers), now sent.
      postPacked(packed, list) {
        native.postMessage({ t: 'm', seq: nextSend, ...packed }, list);
        nextSend++;
      },
      close() {
        try {
          native.postMessage({ t: 'c', seq: nextSend++ });
        } catch {
          /* the other thread is gone */
        }
        end();
      },
      // The port moved on to another thread, its native port and mailbox
      // with it: this side stops reading them (the native port stays open).
      release() {
        ended = true;
        native.onmessage = null;
      },
      // What a port that moves takes with it (all that has come, in its stash).
      state() {
        pull();
        const closing = [...stash.values()].includes(CLOSE);
        return { nextSend, expect, stash: [...stash].filter(([, entry]) => entry !== CLOSE), closing };
      },
    };
    port._attachLink(remote);
    native.onmessage = (event) => {
      const message = event.data;
      if (message?.t === 'm') {
        pull();
        deliver(message.seq, receive(message));
      } else if (message?.t === 'c') {
        pull();
        deliver(message.seq, CLOSE);
      } else onOther?.(message);
    };
    watch();
    return remote;
  }

  /**
   * A jsh port leaving this thread: its envelope, its native port added to
   * `natives` (the transfer list). Its queued messages go with it, their own
   * ports as envelopes too.
   */
  function exportPort(port, natives) {
    const peer = port._localPeer();
    const linked = port._remote();
    const state = linked?.state();
    const { queue, open } = port._detach();
    let native;
    let box;
    if (linked) {
      // Its other end is in another thread already: the native port and
      // the mailboxes go on.
      linked.release();
      native = linked.native;
      box = linked.box;
    } else {
      const channel = new NativeMessageChannel();
      const [here, there] = mailboxPair(CHANNEL_MAILBOX);
      if (peer && !peer._detached) link(peer, channel.port1, undefined, here);
      else channel.port1.close();
      native = channel.port2;
      box = there;
    }
    natives.push(native);
    const exportEntry = ({ data, ports: list }) => {
      if (!list?.length) return { data, ports: [] };
      const marks = new Map(list.map((p, i) => [p, { [kPortMark]: i }]));
      return { data: swapPorts(data, marks), ports: list.map((p) => exportPort(p, natives)) };
    };
    return {
      native,
      box,
      state: state && { nextSend: state.nextSend, expect: state.expect, stash: state.stash.map(([seq, entry]) => [seq, exportEntry(entry)]) },
      queue: queue.map(exportEntry),
      open: open && !state?.closing,
    };
  }

  /** A jsh port for one that came from another thread. */
  function importPort(envelope) {
    const port = makePort();
    for (const entry of envelope.queue ?? []) port._enqueue(receive(entry));
    const state = envelope.state && { ...envelope.state, stash: envelope.state.stash.map(([seq, entry]) => [seq, receive(entry)]) };
    link(port, envelope.native, undefined, envelope.box, state ?? {});
    if (!envelope.open) port._remoteClosed();
    return port;
  }

  /**
   * A message posted before its link is there (a Worker's before its thread
   * is): taken now, as postMessage takes it (its transfers detached here),
   * and sent once the link is there (`remote.postPacked(...held)`).
   */
  function hold(message, transfer) {
    return pack(message, transfer, (packed, list) => {
      const held = structuredClone(packed, { transfer: list });
      return [held, natives(held)];
    });
  }
  const NativePort = NativeMessageChannel ? Object.getPrototypeOf(new NativeMessageChannel().port1).constructor : null;
  function natives(value, out = [], seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return out;
    seen.add(value);
    if (NativePort && value instanceof NativePort) out.push(value);
    else if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype) for (const key of Object.keys(value)) natives(value[key], out, seen);
    return out;
  }

  return { link, pack, hold, receive, exportPort, importPort, mailboxPair, NativeMessageChannel };
}
