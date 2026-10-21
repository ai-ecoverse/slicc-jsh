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
 * here, which a program can't tell from a move. One the mailbox can't take
 * goes on the native port: as those bytes, beside what the platform shares
 * or clones itself (SharedArrayBuffers, Blobs, …), when it transfers only
 * ArrayBuffers (its getters are read once, either way), else as the
 * platform's clone of it (one transferring ports or streams). Every message
 * has the sender's next number, and the receiver hands them to its port in
 * that order, whichever way they came.
 *
 * A jsh port in a message (in its transfer list) goes as the end of a native
 * channel, with its mailboxes, its numbering, the messages it had waiting,
 * and whether it was closed. If its other end is in this thread, that end
 * now talks over the channel's other end.
 *
 * On the native port: { t: 'm', seq, data, ports } for a message (its jsh
 * ports marked in `data`, as the in-thread clone marks them), or
 * { t: 'm', seq, bytes, hosts } for one serialized; { t: 'c', seq } for a
 * close. Anything else is the thread's own (a worker's 'online', its
 * output, …), for `onOther`.
 */
import { isOrdinaryObject, kHostObjects } from '../builtins/v8-serdes.mjs';
import { markIndex, newPortNonce, portMark } from './broadcast-channel.mjs';
import { createMailbox, mailboxReader, mailboxWriter } from './mailbox.mjs';
import { queueMicrotask } from '../async-context.mjs';

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
const sharedByteLength = typeof SharedArrayBuffer === 'function' ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get : null;

// What the platform clones or shares itself: V8's host objects (Blobs,
// keys, images, …), SharedArrayBuffers and WebAssembly's objects. jsh's
// serializer leaves them to it, and the port walk doesn't go into them.
const PLATFORM = [
  'Blob', 'FileList', 'ImageData', 'ImageBitmap', 'CryptoKey', 'DOMMatrixReadOnly', 'DOMPointReadOnly', 'DOMRectReadOnly', 'DOMQuad',
  'RTCCertificate', 'FileSystemHandle', 'VideoFrame', 'AudioData', 'EncodedVideoChunk', 'EncodedAudioChunk', 'OffscreenCanvas',
  'MediaStreamTrack',
]
  .map((name) => globalThis[name])
  .concat(['Module', 'Memory', 'Global', 'Table', 'Tag', 'Exception'].map((name) => globalThis.WebAssembly?.[name]))
  .filter((Class) => typeof Class === 'function');
const isPlatformObject = (value) => (sharedByteLength !== null && hasBrandOf(sharedByteLength, value)) || PLATFORM.some((Class) => value instanceof Class);
const unlisted = () => new DOMException('Object that needs transfer was found in message but not listed in transferList', 'DataCloneError');
const detached = () => new DOMException('MessagePort in transfer list is already detached', 'DataCloneError');

// What a transfer list may hold (Node's): ArrayBuffers (not shared ones),
// message ports (jsh's and the platform's) and web streams. Each by its
// brand: a getter of its own that throws for anything else (a tag or a
// prototype can be faked; a fake would pass, and only fail once a port had
// gone).
const getterOf = (Class, key) => (typeof Class === 'function' ? Object.getOwnPropertyDescriptor(Class.prototype, key)?.get : undefined);
function hasBrandOf(get, item) {
  try {
    Reflect.apply(get, item, []);
    return true;
  } catch {
    return false;
  }
}
const hasBrand = (get, item) => {
  try {
    Reflect.apply(get, item, []);
    return true;
  } catch {
    return false;
  }
};
const isTransferable = (item, JshPort, brands) =>
  item !== null &&
  typeof item === 'object' &&
  (item instanceof JshPort || isArrayBuffer(item) || brands.some((get) => hasBrand(get, item)));

/**
 * V8's checks of a transfer list, made before anything is sent or any port
 * exported, with its errors: what can't be transferred at all, a duplicate,
 * or an ArrayBuffer already gone.
 */
function checkTransferList(list, JshPort, brands) {
  const seen = new Set();
  for (const item of list) {
    if (!isTransferable(item, JshPort, brands)) throw new DOMException('Found invalid value in transferList.', 'DataCloneError');
    if (seen.has(item)) {
      const kind = isArrayBuffer(item) ? 'ArrayBuffer' : 'MessagePort';
      throw new DOMException(`Transfer list contains duplicate ${kind}`, 'DataCloneError');
    }
    seen.add(item);
    if (isArrayBuffer(item) && item.detached) throw new DOMException('Cannot transfer object of unsupported type.', 'DataCloneError');
  }
}

/**
 * The mailboxes' serialization: the structured clone's own algorithm (V8's
 * ValueSerializer, `process`'s v8, made when first used). `host` gives an
 * index for what the platform clones or shares itself, sent beside the
 * bytes, as V8's host objects are; what it can't write is V8's
 * DataCloneError.
 */
export function mailboxSerdes(process) {
  let made;
  return () =>
    (made ??= (() => {
      const v8 = process._builtin('v8');
      return {
        serialize(value, host) {
          const ser = new v8.Serializer();
          ser._getDataCloneError = function DataCloneError(message) {
            return new DOMException(message, 'DataCloneError');
          };
          if (host) ser[kHostObjects] = host;
          ser.writeHeader();
          ser.writeValue(value);
          return ser.releaseBuffer();
        },
        deserialize(bytes, hosts) {
          const der = new v8.Deserializer(bytes);
          if (hosts) der[kHostObjects] = (i) => hosts[i];
          der.readHeader();
          return der.readValue();
        },
      };
    })());
}

export function createRemotePorts({ ports, NativeMessageChannel, serdes, handles }) {
  const { MessagePort, makePort } = ports;
  const readableLocked = getterOf(globalThis.ReadableStream, 'locked');
  const isReadable = (value) => !!readableLocked && hasBrand(readableLocked, value);
  const transformReadable = getterOf(globalThis.TransformStream, 'readable');
  const isTransform = (value) => !!transformReadable && hasBrand(transformReadable, value);
  const { defineProperty } = Object;
  // The platform's, taken before the program runs (which may replace them).
  const NativeReadableStream = globalThis.ReadableStream;
  const { apply } = Reflect;
  const getReader = NativeReadableStream?.prototype.getReader;
  const ReaderPrototype = NativeReadableStream && Object.getPrototypeOf(new NativeReadableStream().getReader());
  const readerRead = ReaderPrototype?.read;
  const readerCancel = ReaderPrototype?.cancel;
  const streamCancel = NativeReadableStream?.prototype.cancel;

  // A ReadableStream that came from another thread holds the program while
  // a read on it is pending (its chunks come from that thread), as Node's
  // does, and not otherwise: the stream the program gets reads it through
  // one that holds a handle while each read is in flight.
  function heldWhileRead(stream) {
    if (!handles) return stream;
    let reader;
    return new NativeReadableStream(
      {
        async pull(controller) {
          reader ??= apply(getReader, stream, []);
          const handle = { kind: 'message-port' };
          handles.add(handle);
          try {
            const { value, done } = await apply(readerRead, reader, []);
            if (done) controller.close();
            else controller.enqueue(value);
          } finally {
            handles.delete(handle);
          }
        },
        cancel: (reason) => (reader ? apply(readerCancel, reader, [reason]) : apply(streamCancel, stream, [reason])),
      },
      { highWaterMark: 0 }
    );
  }
  const NativePort = NativeMessageChannel ? Object.getPrototypeOf(new NativeMessageChannel().port1).constructor : null;
  const brands = [
    getterOf(NativePort, 'onmessage'),
    getterOf(globalThis.ReadableStream, 'locked'),
    getterOf(globalThis.WritableStream, 'locked'),
    getterOf(globalThis.TransformStream, 'readable'),
  ].filter(Boolean);

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
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
      // Another object: an ordinary one (a class instance) is what
      // structured clone makes a plain one of, of its own enumerable
      // properties, so the copy is that, its getters read once, here. A
      // builtin or a platform object (a stream, a native port) goes as it
      // is, never walked.
      if (!isOrdinaryObject(value) || isPlatformObject(value) || brands.some((get) => hasBrand(get, value))) return value;
      const copy = {};
      seen.set(value, copy);
      for (const key of Object.keys(value)) copy[key] = mapPorts(value[key], swap, seen);
      return copy;
    }
    const out = Array.isArray(value) ? new Array(value.length) : {};
    seen.set(value, out);
    for (const key of Object.keys(value)) out[key] = mapPorts(value[key], swap, seen);
    return out;
  }
  // A port that isn't listed (jsh's or the platform's), or a stream, is
  // Node's DataCloneError: it would only go by being transferred.
  const transformWritable = getterOf(globalThis.TransformStream, 'writable');
  // What's listed, with a listed TransformStream's two sides (they go with it).
  const withSides = (listed) =>
    listed.flatMap((x) => (isTransform(x) ? [x, apply(transformReadable, x, []), apply(transformWritable, x, [])] : [x]));
  const swapPorts = (value, marks, listed) => {
    const known = withSides(listed);
    return mapPorts(value, (v) => {
      const mark = marks.get(v);
      if (mark) return mark;
      if (known.includes(v)) return v;
      if (v instanceof MessagePort || brands.some((get) => hasBrand(get, v))) throw unlisted();
      return undefined;
    });
  };

  /**
   * `message` and its transfer list as the platform can clone them: the
   * message (its jsh ports marked) and the native transfer list, for `fn`,
   * which must clone at once (postMessage does); the value is unmarked after.
   */
  function pack(message, transfer, fn) {
    const list = transferListOf(transfer);
    const jshPorts = list.filter((x) => x instanceof MessagePort);
    const rest = list.filter((x) => !(x instanceof MessagePort));
    // One moved on already, or closed by the program (not by its other end).
    for (const port of jshPorts) if (port._unusable()) throw detached();
    checkTransferList(list, MessagePort, brands);
    const nonce = newPortNonce();
    const marks = new Map(jshPorts.map((port, i) => [port, portMark(nonce, i)]));
    // Staged first, the rest of the transfer list (platform ports, streams,
    // buffers) moved into the clone: what can't be cloned (a function) or
    // transferred (a port or stream already gone) fails here, before any jsh
    // port is exported, which leaves them this side's, usable, as in Node.
    // The walk reads each property once; the clone takes its copy.
    const staged = structuredClone({ marked: swapPorts(message, marks, rest), rest }, { transfer: rest });
    // Whether the receiver has streams to find in it.
    const streams = rest.some((x) => isReadable(x) || isTransform(x));
    if (jshPorts.length === 0) return fn({ data: staged.marked, ports: [], streams }, staged.rest);
    const natives = [];
    const envelopes = jshPorts.map((port) => exportPort(port, natives));
    return fn({ data: staged.marked, ports: envelopes, nonce, streams }, [...natives, ...staged.rest]);
  }

  function receive(message) {
    if (message.bytes) return { data: serdes().deserialize(message.bytes, message.hosts), ports: [] };
    const list = (message.ports ?? []).map(importPort);
    if (!list.length && !message.streams) return { data: message.data, ports: list };
    // One wrapper for each stream, wherever it is in the message (an alias stays one).
    const wrappers = new Map();
    const data = mapPorts(message.data, (v) => {
      const at = list.length ? markIndex(v, message.nonce) : -1;
      if (at >= 0) return list[at];
      if (!message.streams) return undefined;
      // A TransformStream's readable side is read the same way: its
      // chunks come back from the other thread (where its other end is).
      // (One wrapper for its readable side, which may be in the message too.)
      if (isTransform(v) && !wrappers.has(v)) {
        wrappers.set(v, v);
        const raw = apply(transformReadable, v, []);
        if (!wrappers.has(raw)) wrappers.set(raw, heldWhileRead(raw));
        defineProperty(v, 'readable', { value: wrappers.get(raw), configurable: true, enumerable: false });
      }
      if (!isReadable(v)) return undefined;
      if (!wrappers.has(v)) wrappers.set(v, heldWhileRead(v));
      return wrappers.get(v);
    });
    return { data, ports: list };
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
    // The native port closed with it (its peer closed, or this side did).
    let transportClosed = false;
    // Who waits for a message's number to be reached (whenReceived).
    const waiters = [];
    const reached = (n) => ((n - expect) >>> 0 === 0 || (n - expect) >>> 0 > 0x7fffffff);
    const wake = () => {
      for (let i = waiters.length - 1; i >= 0; i--) {
        const [n, fn] = waiters[i];
        if (ended || reached(n)) {
          waiters.splice(i, 1);
          fn();
        }
      }
    };

    const end = () => {
      ended = true;
      transportClosed = !onOther;
      queueMicrotask(wake);
      if (!onOther) {
        native.onmessage = null;
        native.removeEventListener('close', nativeClosed);
        native.close();
      }
    };
    // The native port closed with no close record: its thread ended with
    // the other end open (unref'd). What came is taken, then the port closes.
    const nativeClosed = () => {
      if (ended) return;
      pull();
      end();
      port._remoteClosed();
    };
    // Hand the port what has come, in its numbers' order.
    const deliver = (seq, entry) => {
      stash.set(seq, entry);
      while (stash.has(expect)) {
        const next = stash.get(expect);
        stash.delete(expect);
        // Numbers go modulo 2^32, as the mailbox stores them.
        expect = (expect + 1) >>> 0;
        if (next === CLOSE) {
          end();
          port._remoteClosed();
          return;
        }
        port._enqueue(next);
      }
      if (waiters.length) wake();
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
        // A port can't send itself (Node's DataCloneError), checked before
        // anything leaves: exported, it would cut its own link.
        if (list.includes(port)) throw new DOMException('Transfer list contains source port', 'DataCloneError');
        // Nothing to transfer but ArrayBuffers: serialized once (its
        // getters read once, what it can't be is the post's error), the
        // buffers' bytes copied and theirs detached (a move, as a program
        // sees it).
        if (list.every(isArrayBuffer)) {
          // V8's checks of a transfer list, before the message is out.
          checkTransferList(list, MessagePort, brands);
          const hosts = [];
          const bytes = serdes().serialize(message, (object) => {
            if (object instanceof MessagePort || brands.some((get) => hasBrand(get, object))) throw unlisted();
            return isPlatformObject(object) ? hosts.push(object) - 1 : undefined;
          });
          // A buffer the message's getters detached meanwhile is gone
          // already: the rest move, and the post stands, as in Node.
          const live = list.filter((b) => !b.detached);
          if (writer && hosts.length === 0 && writer.fits(bytes.length)) {
            // They move before the record is out: one that can't (a
            // WebAssembly.Memory's) fails the post with nothing sent.
            if (live.length) structuredClone(live, { transfer: live });
            writer.write(seq, bytes);
          } else {
            // The native way, the buffers moved with it (or neither).
            native.postMessage({ t: 'm', seq, bytes, hosts, moved: live }, live);
          }
          nextSend = (nextSend + 1) >>> 0;
          return;
        }
        pack(message, transfer, (packed, natives) => {
          native.postMessage({ t: 'm', seq, ...packed }, natives);
          nextSend = (nextSend + 1) >>> 0;
        });
      },
      // A message packed and cloned before (with its transfers), now sent.
      postPacked(packed, list) {
        native.postMessage({ t: 'm', seq: nextSend, ...packed }, list);
        nextSend = (nextSend + 1) >>> 0;
      },
      close() {
        try {
          native.postMessage({ t: 'c', seq: nextSend });
          nextSend = (nextSend + 1) >>> 0;
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
        native.removeEventListener('close', nativeClosed);
      },
      get transportClosed() {
        return transportClosed;
      },
      // How many messages this side has sent (modulo 2^32).
      get sent() {
        return nextSend;
      },
      // `fn` once every message numbered below `n` has come (or the link ended).
      whenReceived(n, fn) {
        pull();
        if (ended || reached(n)) fn();
        else waiters.push([n, fn]);
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
    if (!onOther) native.addEventListener('close', nativeClosed);
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
    // A link whose peer closed has closed its native port too: the port
    // goes over a fresh one, its other end closed, its messages with it.
    const peerClosed = linked?.transportClosed ?? false;
    if (linked && !peerClosed) {
      // Its other end is in another thread already: the native port and
      // the mailboxes go on.
      linked.release();
      native = linked.native;
      box = linked.box;
    } else {
      linked?.release();
      const channel = new NativeMessageChannel();
      const [here, there] = mailboxPair(CHANNEL_MAILBOX);
      if (!linked && peer && !peer._detached) link(peer, channel.port1, undefined, here);
      else channel.port1.close();
      native = channel.port2;
      box = there;
    }
    natives.push(native);
    const exportEntry = ({ data, ports: list }) => {
      if (!list?.length) return { data, ports: [] };
      const nonce = newPortNonce();
      const marks = new Map(list.map((p, i) => [p, portMark(nonce, i)]));
      return { data: swapPorts(data, marks, []), ports: list.map((p) => exportPort(p, natives)), nonce };
    };
    return {
      native,
      box,
      state: state && { nextSend: state.nextSend, expect: state.expect, stash: state.stash.map(([seq, entry]) => [seq, exportEntry(entry)]) },
      queue: queue.map(exportEntry),
      open: open && !state?.closing && !peerClosed,
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
      // The clone's own transferables (ports, buffers, streams), to be
      // transferred again when it is sent.
      const held = structuredClone({ packed, list }, { transfer: list });
      return [held.packed, held.list];
    });
  }

  // A linked port transferred within this thread: exported and imported
  // again, a new port on the same channel.
  ports.setLinkedMover?.((port) => {
    const natives = [];
    const envelope = exportPort(port, natives);
    return importPort(structuredClone(envelope, { transfer: natives }));
  });

  return { link, pack, hold, receive, exportPort, importPort, mailboxPair, NativeMessageChannel };
}
