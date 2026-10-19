/**
 * Node 22.22.0's IPC channel (lib/internal/child_process.js: setupChannel,
 * Control), over a kernel socket fd instead of libuv's IPC Pipe. The parent
 * end of a fork, or spawn with 'ipc' in stdio, is one end of a socketpair
 * the child has at NODE_CHANNEL_FD; the child's process.send / 'message' /
 * disconnect are set up on that fd at start (_forkChild).
 *
 * Messages are framed as Node frames them, by its own
 * lib/internal/child_process/serialization.js: one JSON text and '\n' each
 * ('json'), or a 4-byte big-endian length and V8's serialization
 * ('advanced'), so both ends could be Node.
 *
 * Not here: handles (send(message, socket | server | dgram)). The kernel
 * can't pass a descriptor between processes, so a send with a handle fails
 * with ERR_NOT_SUPPORTED, on its callback or as 'error', and nothing is
 * written.
 */
import { nodeError, ERR_INVALID_ARG_TYPE, ERR_MISSING_ARGS, validateObject } from '../node-errors.mjs';
import { EventEmitter } from './events.mjs';

const kPendingMessages = Symbol('kPendingMessages');
const kChannelHandle = Symbol('kChannelHandle');
const INTERNAL_PREFIX = 'NODE_';
const READ_SIZE = 64 * 1024;
// libuv tries a write at once (uv_try_write) and queues what doesn't fit:
// Node's channel writes are mostly done when send() returns. On a kernel
// with non-blocking writes and select (slicc-kernel 1.126.0) a write with
// nothing queued before it is tried at once, the rest is queued and written
// as the socket takes it. Before that, a small write with nothing queued is
// written at once, waiting on a peer that has stopped reading (the kernel's
// socket buffer is 64 KiB); a bigger one, or one behind others, is queued.
const WRITE_AT_ONCE = 16 * 1024;
const NONBLOCK = Object.freeze({ nonblock: true });
const uvWriteError = (err) => (err?.code === 'EPIPE' ? -32 : -5); // UV_EPIPE, UV_EIO

const ERR_IPC_CHANNEL_CLOSED = () => nodeError(Error, 'ERR_IPC_CHANNEL_CLOSED', 'Channel closed');
const ERR_IPC_DISCONNECTED = () => nodeError(Error, 'ERR_IPC_DISCONNECTED', 'IPC channel is already disconnected');
const handlesNotSupported = () =>
  nodeError(Error, 'ERR_NOT_SUPPORTED', 'slicc-jsh: sending a handle over an IPC channel is not supported (the kernel has no descriptor passing)');

export function isInternal(message) {
  return (
    message !== null &&
    typeof message === 'object' &&
    typeof message.cmd === 'string' &&
    message.cmd.length > INTERNAL_PREFIX.length &&
    message.cmd.slice(0, INTERNAL_PREFIX.length) === INTERNAL_PREFIX
  );
}

/**
 * What setupChannel and serialization.js ask of libuv's IPC Pipe, on a
 * kernel fd: readStart, onread with the stream_wrap state, writeBuffer /
 * writeUtf8String with a WriteWrap's oncomplete, writeQueueSize, ref /
 * unref, close. A pending read doesn't keep the program alive by itself;
 * ref() does (Control counts the channel's users, as in Node).
 */
export function createChannelHandle({ ctx, handles, streamBaseState, constants, fd, exitFlush }) {
  const { kReadBytesOrError, kArrayBufferOffset, kLastWriteWasAsync } = constants;
  const encoder = new TextEncoder();
  const handle = { kind: 'PipeWrap' };
  let refed = true;
  let closed = false;
  let reading = false;
  const writes = [];
  let writing = false;
  // Waiting for the socket to take more (try-write), aborted at exit.
  let waiting = null;
  const tryWrite = typeof ctx.select === 'function' && typeof ctx.sync?.write === 'function';
  handles.add(handle);

  const channel = {
    fd,
    writeQueueSize: 0,
    onread: () => {},
    readStart() {
      if (reading || closed) return 0;
      reading = true;
      (async () => {
        while (reading && !closed) {
          let chunk;
          try {
            chunk = await ctx.read(fd, READ_SIZE);
          } catch {
            chunk = new Uint8Array(0);
          }
          if (closed) return;
          if (chunk.length === 0) {
            reading = false;
            streamBaseState[kReadBytesOrError] = -4095; // UV_EOF
            channel.onread(undefined);
            handles.notify?.();
            return;
          }
          streamBaseState[kReadBytesOrError] = chunk.length;
          streamBaseState[kArrayBufferOffset] = chunk.byteOffset;
          channel.onread(chunk.buffer);
          handles.notify?.();
        }
      })();
      return 0;
    },
    readStop() {
      reading = false;
      return 0;
    },
    writeBuffer(req, data) {
      return queueWrite(req, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    },
    writeUtf8String(req, string) {
      return queueWrite(req, encoder.encode(string));
    },
    ref() {
      if (closed || refed) return;
      refed = true;
      handles.add(handle);
    },
    unref() {
      if (!refed) return;
      refed = false;
      handles.delete(handle);
    },
    close() {
      if (closed) return;
      closed = true;
      reading = false;
      refed = false;
      handles.delete(handle);
      // Node's writes are usually done by the time it closes (libuv tries
      // them at once); here they are written out first.
      if (!writing) shut();
    },
  };

  const shut = () => {
    exitFlush?.delete(flushSync);
    ctx.close(fd).catch(() => {});
  };

  function queueWrite(req, bytes) {
    if (closed && !writing) return -32; // UV_EPIPE
    if (tryWrite && !writing && writes.length === 0) {
      let taken = 0;
      try {
        taken = ctx.sync.write(fd, bytes, NONBLOCK);
      } catch (err) {
        if (err?.code !== 'EAGAIN') return uvWriteError(err);
      }
      if (taken === bytes.length) {
        streamBaseState[kLastWriteWasAsync] = 0;
        return 0;
      }
      bytes = bytes.subarray(taken);
    } else if (!tryWrite && !writing && writes.length === 0 && bytes.length <= WRITE_AT_ONCE && typeof ctx.sync?.write === 'function') {
      try {
        ctx.sync.write(fd, bytes);
      } catch (err) {
        return uvWriteError(err);
      }
      streamBaseState[kLastWriteWasAsync] = 0;
      return 0;
    }
    writes.push({ req, bytes });
    channel.writeQueueSize += bytes.length;
    streamBaseState[kLastWriteWasAsync] = 1;
    // On a later turn: the caller (setupChannel's _send) gives the request
    // its oncomplete once this returns, and a drain that finished at once
    // would call it before.
    if (!writing) {
      writing = true;
      queueMicrotask(drain);
    }
    return 0;
  }

  // The program ends (process.exit(), or its loop is done): what is still
  // queued is written now, unless a write is in flight (written now, it
  // could pass that one; it is lost then, as a write libuv couldn't do at
  // once is when Node exits). A try-write drain has no write in flight
  // (each is done at once; it only waits between them, or for its turn), so
  // what it has left is written here, as far as the socket takes it: the
  // peer may be waiting for this program to end before it reads, so the rest
  // is lost, as Node loses it.
  const flushSync = () => {
    if (writing && !tryWrite) return;
    waiting?.abort();
    waiting = null;
    const left = writes.splice(0);
    for (const { req, bytes } of left) {
      channel.writeQueueSize -= bytes.length;
      try {
        if (!tryWrite) ctx.sync.write(fd, bytes);
        else if (ctx.sync.write(fd, bytes, NONBLOCK) < bytes.length) return;
        req.oncomplete?.(0);
      } catch {
        if (tryWrite) return;
        req.oncomplete?.(-32);
      }
    }
  };
  exitFlush?.add(flushSync);

  async function drain() {
    writing = true;
    if (tryWrite) await drainTrying();
    else await drainWaiting();
    writing = false;
    if (closed) shut();
    handles.notify?.();
  }

  // Each write takes what the socket has room for; between them, select
  // waits for room. flushSync can take the queue over while it waits.
  async function drainTrying() {
    while (writes.length) {
      const write = writes[0];
      let status = 0;
      try {
        const taken = ctx.sync.write(fd, write.bytes, NONBLOCK);
        write.bytes = write.bytes.subarray(taken);
        channel.writeQueueSize -= taken;
      } catch (err) {
        if (err?.code !== 'EAGAIN') status = uvWriteError(err);
      }
      if (status === 0 && write.bytes.length > 0) {
        waiting = new AbortController();
        try {
          await ctx.select({ write: [fd] }, { signal: waiting.signal });
        } catch {
          /* aborted: flushSync has the queue */
        }
        waiting = null;
        if (writes[0] !== write) return;
        continue;
      }
      writes.shift();
      channel.writeQueueSize -= write.bytes.length;
      write.req.oncomplete?.(status);
    }
  }

  async function drainWaiting() {
    while (writes.length) {
      const { req, bytes } = writes.shift();
      let status = 0;
      try {
        await ctx.write(fd, bytes);
      } catch (err) {
        status = uvWriteError(err);
      }
      channel.writeQueueSize -= bytes.length;
      req.oncomplete?.(status);
    }
  }

  return channel;
}

class Control {
  #channel = null;
  #refs = 0;
  #refExplicitlySet = false;
  #events;

  constructor(channel) {
    this.#events = new EventEmitter();
    this.#channel = channel;
    this[kPendingMessages] = [];
  }

  // The listener count on the target and the writes in progress keep the
  // channel ref'd; once the program has said ref() or unref(), these do nothing.
  refCounted() {
    if (++this.#refs === 1 && !this.#refExplicitlySet) this.#channel.ref();
  }

  unrefCounted() {
    if (--this.#refs === 0 && !this.#refExplicitlySet) {
      this.#channel.unref();
      this.#events.emit('unref');
    }
  }

  ref() {
    this.#refExplicitlySet = true;
    this.#channel.ref();
  }

  unref() {
    this.#refExplicitlySet = true;
    this.#channel.unref();
  }

  get fd() {
    return this.#channel ? this.#channel.fd : undefined;
  }
}

/**
 * setupChannel(target, channel, serializationMode): Node's, with the handle
 * passing taken out. `maybeClose(target)` is the ChildProcess's close count
 * (the process itself has none).
 */
export function setupChannel({ target, channel, serializationMode, serialization, process, deprecate, maybeClose }) {
  const control = new Control(channel);
  target.channel = control;
  target[kChannelHandle] = channel;

  const channelDeprecationMsg = '_channel is deprecated. Use ChildProcess.channel instead.';
  Object.defineProperty(target, '_channel', {
    __proto__: null,
    get: deprecate(() => target.channel, channelDeprecationMsg, 'DEP0129'),
    set: deprecate((val) => {
      target.channel = val;
    }, channelDeprecationMsg, 'DEP0129'),
    configurable: true,
    enumerable: false,
  });

  target._handleQueue = null;
  target._pendingMessage = null;

  const { initMessageChannel, parseChannelMessages, writeChannelMessage } = serialization[serializationMode];
  const { streamBaseState, kReadBytesOrError, kArrayBufferOffset, kLastWriteWasAsync } = serialization.streamWrap;

  initMessageChannel(channel);
  channel.pendingHandle = null;
  channel.onread = function onread(arrayBuffer) {
    if (arrayBuffer) {
      const nread = streamBaseState[kReadBytesOrError];
      const offset = streamBaseState[kArrayBufferOffset];
      const pool = new Uint8Array(arrayBuffer, offset, nread);
      for (const message of parseChannelMessages(channel, pool)) {
        handleMessage(message, undefined, isInternal(message));
      }
    } else {
      channel.buffering = false;
      target.disconnect();
      channel.onread = () => {};
      channel.close();
      target.channel = null;
      maybeClose?.(target);
    }
  };

  channel.sockets = { got: {}, send: {} };

  target.on('newListener', function () {
    process.nextTick(() => {
      if (!target.channel || !target.listenerCount('message')) return;
      const messages = target.channel[kPendingMessages];
      const { length } = messages;
      if (!length) return;
      for (let i = 0; i < length; i++) Reflect.apply(target.emit, target, messages[i]);
      target.channel[kPendingMessages] = [];
    });
  });

  target.send = function send(message, handle, options, callback) {
    if (typeof handle === 'function') {
      callback = handle;
      handle = undefined;
      options = undefined;
    } else if (typeof options === 'function') {
      callback = options;
      options = undefined;
    } else if (options !== undefined) {
      validateObject(options, 'options');
    }

    options = { swallowErrors: false, ...options };

    if (this.connected) return this._send(message, handle, options, callback);
    const ex = ERR_IPC_CHANNEL_CLOSED();
    if (typeof callback === 'function') process.nextTick(callback, ex);
    else process.nextTick(() => this.emit('error', ex));
    return false;
  };

  target._send = function _send(message, handle, options, callback) {
    if (message === undefined) throw ERR_MISSING_ARGS('message');

    // Non-serializable messages should not reach the other end.
    if (typeof message !== 'string' && typeof message !== 'object' && typeof message !== 'number' && typeof message !== 'boolean') {
      throw ERR_INVALID_ARG_TYPE('message', ['string', 'object', 'number', 'boolean'], message);
    }

    // The legacy signature: a boolean for swallowErrors.
    if (typeof options === 'boolean') options = { swallowErrors: options };

    if (handle) {
      const ex = handlesNotSupported();
      if (typeof callback === 'function') process.nextTick(callback, ex);
      else process.nextTick(() => this.emit('error', ex));
      return false;
    }

    const req = {};
    const err = writeChannelMessage(channel, req, message, null);
    const wasAsyncWrite = streamBaseState[kLastWriteWasAsync];

    if (err === 0) {
      if (wasAsyncWrite) {
        req.oncomplete = () => {
          control.unrefCounted();
          if (typeof callback === 'function') callback(null);
        };
        control.refCounted();
      } else if (typeof callback === 'function') {
        process.nextTick(callback, null);
      }
    } else if (!options?.swallowErrors) {
      const ex = nodeError(Error, 'EPIPE', 'write EPIPE');
      ex.errno = -32;
      ex.syscall = 'write';
      if (typeof callback === 'function') process.nextTick(callback, ex);
      else process.nextTick(() => this.emit('error', ex));
    }

    // If the other end is more than two reads behind, stop sending.
    return channel.writeQueueSize < 65536 * 2;
  };

  // connected is false as soon as disconnect() is asked for; the channel
  // goes (channel null) once what was queued has been written.
  target.connected = true;

  target.disconnect = function disconnect() {
    if (!this.connected) {
      this.emit('error', ERR_IPC_DISCONNECTED());
      return;
    }
    this.connected = false;
    if (!this._handleQueue) this._disconnect();
  };

  target._disconnect = function _disconnect() {
    this.channel = null;
    this[kChannelHandle] = null;

    let fired = false;
    function finish() {
      if (fired) return;
      fired = true;
      channel.close();
      target.emit('disconnect');
    }

    // A message being read is delivered first.
    if (channel.buffering) {
      this.once('message', finish);
      this.once('internalMessage', finish);
      return;
    }

    process.nextTick(finish);
  };

  function emit(event, message, handle) {
    if (event === 'internalMessage' || target.listenerCount('message')) {
      target.emit(event, message, handle);
      return;
    }
    target.channel[kPendingMessages].push([event, message, handle]);
  }

  function handleMessage(message, handle, internal) {
    if (!target.channel) return;
    process.nextTick(emit, internal ? 'internalMessage' : 'message', message, handle);
  }

  channel.readStart();
  return control;
}

/** A channel handle on `fd`, with the serialization module's stream_wrap state. */
export function channelOn({ ctx, handles, serialization, fd, process }) {
  const { streamBaseState, kReadBytesOrError, kArrayBufferOffset, kLastWriteWasAsync } = serialization.streamWrap;
  return createChannelHandle({
    ctx,
    handles,
    streamBaseState,
    constants: { kReadBytesOrError, kArrayBufferOffset, kLastWriteWasAsync },
    fd,
    exitFlush: process ? (process._exitFlush ??= new Set()) : undefined,
  });
}

/**
 * The child's end, at start (lib/internal/process/pre_execution.js
 * setupChildProcessIpcChannel and child_process._forkChild): process.send,
 * process.channel, 'message' and 'disconnect' on NODE_CHANNEL_FD, which
 * leaves the environment. The channel keeps the program alive only while
 * it has 'message' or 'disconnect' listeners.
 */
export function setupChildChannel({ ctx, process, handles }) {
  const raw = process.env.NODE_CHANNEL_FD;
  if (raw === undefined || typeof ctx?.socketpair !== 'function') return;
  const fd = Number.parseInt(raw, 10);
  if (!(fd >= 0)) return;
  delete process.env.NODE_CHANNEL_FD;
  const serializationMode = process.env.NODE_CHANNEL_SERIALIZATION_MODE || 'json';
  delete process.env.NODE_CHANNEL_SERIALIZATION_MODE;
  const serialization = process._nodeLib().childProcessSerialization;
  const channel = channelOn({ ctx, handles, serialization, fd, process });
  channel.unref();
  const deprecate = process._builtin?.('util')?.deprecate ?? ((fn) => fn);
  const control = setupChannel({ target: process, channel, serializationMode, serialization, process, deprecate });
  process.on('newListener', function onNewListener(name) {
    if (name === 'message' || name === 'disconnect') control.refCounted();
  });
  process.on('removeListener', function onRemoveListener(name) {
    if (name === 'message' || name === 'disconnect') control.unrefCounted();
  });
}
