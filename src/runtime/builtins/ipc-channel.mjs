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
 * Handles (send(message, socket | server)) go as Node sends them: a
 * NODE_HANDLE message whose first byte carries the descriptor, as
 * SCM_RIGHTS (the kernel's sendmsg and recvmsg), acknowledged by the other
 * end. A kernel without them (the browser's) can't pass a descriptor, so a
 * send with a handle fails with ERR_NOT_SUPPORTED, on its callback or as
 * 'error', and nothing is written.
 */
import { nodeError, ERR_INVALID_ARG_TYPE, ERR_MISSING_ARGS, validateObject } from '../node-errors.mjs';
import { EventEmitter } from './events.mjs';
import { queueMicrotask } from '../async-context.mjs';
import { trackPromise } from '../async-handles.mjs';
import { kIpc } from './net.mjs';

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
const RECEIVE = Object.freeze({ cloexec: true });
const UV_WRITE_ERRORS = { EPIPE: -32, EPERM: -1, EBADF: -9, EINVAL: -22, EMFILE: -24, EOPNOTSUPP: -95 };
const uvWriteError = (err) => UV_WRITE_ERRORS[err?.code] ?? -5;
const MAX_HANDLE_RETRANSMISSIONS = 3;

const ERR_IPC_CHANNEL_CLOSED = () => nodeError(Error, 'ERR_IPC_CHANNEL_CLOSED', 'Channel closed');
const ERR_IPC_DISCONNECTED = () => nodeError(Error, 'ERR_IPC_DISCONNECTED', 'IPC channel is already disconnected');
const handlesNotSupported = () =>
  nodeError(Error, 'ERR_NOT_SUPPORTED', 'slicc-jsh: sending a handle over an IPC channel is not supported (the kernel has no descriptor passing)');
const ERR_INVALID_HANDLE_TYPE = () => nodeError(TypeError, 'ERR_INVALID_HANDLE_TYPE', 'This handle type cannot be sent');
const ERR_CHILD_CLOSED_BEFORE_REPLY = () => nodeError(Error, 'ERR_CHILD_CLOSED_BEFORE_REPLY', 'Child closed before reply received');
const UV_WRITE_CODES = Object.fromEntries(Object.entries(UV_WRITE_ERRORS).map(([code, errno]) => [errno, code]));

class TLSWrap {
  #handle;
  constructor(handle) {
    this.#handle = handle;
  }
  close() {
    this.#handle?.close();
  }
}

class SocketListSend extends EventEmitter {
  constructor(child, key) {
    super();
    this.key = key;
    this.child = child;
    child.once('exit', () => this.emit('exit', this));
  }

  _request(msg, cmd, swallowErrors, callback) {
    const self = this;
    if (!this.child.connected) return onclose();
    this.child._send(msg, undefined, swallowErrors);
    function onclose() {
      self.child.removeListener('internalMessage', onreply);
      callback(ERR_CHILD_CLOSED_BEFORE_REPLY());
    }
    function onreply(msg) {
      if (!(msg.cmd === cmd && msg.key === self.key)) return;
      self.child.removeListener('disconnect', onclose);
      self.child.removeListener('internalMessage', onreply);
      callback(null, msg);
    }
    this.child.once('disconnect', onclose);
    this.child.on('internalMessage', onreply);
  }

  close(callback) {
    this._request({ cmd: 'NODE_SOCKET_NOTIFY_CLOSE', key: this.key }, 'NODE_SOCKET_ALL_CLOSED', true, callback);
  }

  getConnections(callback) {
    this._request({ cmd: 'NODE_SOCKET_GET_COUNT', key: this.key }, 'NODE_SOCKET_COUNT', false, (err, msg) => {
      if (err) return callback(err);
      callback(null, msg.count);
    });
  }
}

class SocketListReceive extends EventEmitter {
  constructor(child, key) {
    super();
    this.connections = 0;
    this.key = key;
    this.child = child;
    function onempty(self) {
      if (!self.child.connected) return;
      self.child._send({ cmd: 'NODE_SOCKET_ALL_CLOSED', key: self.key }, undefined, true);
    }
    this.child.on('internalMessage', (msg) => {
      if (msg.key !== this.key) return;
      if (msg.cmd === 'NODE_SOCKET_NOTIFY_CLOSE') {
        if (this.connections === 0) return onempty(this);
        this.once('empty', onempty);
      } else if (msg.cmd === 'NODE_SOCKET_GET_COUNT') {
        if (!this.child.connected) return;
        this.child._send({ cmd: 'NODE_SOCKET_COUNT', key: this.key, count: this.connections });
      }
    });
  }

  add(obj) {
    this.connections++;
    obj.socket.once('close', () => {
      this.connections--;
      if (this.connections === 0) this.emit('empty', this);
    });
  }
}

export const channelPassesHandles = (target) => target?.[kChannelHandle]?.passesHandles === true;

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
export function createChannelHandle({ ctx, handles, streamBaseState, constants, fd, exitFlush, timers }) {
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
  const passing = tryWrite && typeof ctx.sync.sendmsg === 'function' && typeof ctx.recvmsg === 'function' && typeof ctx.net?.adopt === 'function';
  const put = (bytes, fds) => (fds ? ctx.sync.sendmsg(fd, bytes, { fds, nonblock: true }) : ctx.sync.write(fd, bytes, NONBLOCK));
  const fdsOf = (sendHandle) => (passing && typeof sendHandle?.fd === 'number' ? [sendHandle.fd] : undefined);
  const closeFds = (fds) => fds.forEach((n) => ctx.close(n).catch(() => {}));
  handles.add(handle);

  const channel = {
    fd,
    passesHandles: passing,
    closeFds,
    track: (promise) => trackPromise(handles, promise),
    writeQueueSize: 0,
    onread: () => {},
    readStart() {
      if (reading || closed) return 0;
      reading = true;
      (async () => {
        while (reading && !closed) {
          let chunk;
          let fds = [];
          let ctrunc = false;
          try {
            if (passing) ({ bytes: chunk, fds, ctrunc } = await ctx.recvmsg(fd, READ_SIZE, RECEIVE));
            else chunk = await ctx.read(fd, READ_SIZE);
          } catch {
            chunk = new Uint8Array(0);
          }
          if (closed || ctrunc) closeFds(fds.splice(0));
          if (closed) return;
          if (chunk.length === 0) {
            reading = false;
            streamBaseState[kReadBytesOrError] = -4095; // UV_EOF
            channel.onread(undefined);
            handles.notify?.();
            return;
          }
          if (fds.length > 0) {
            channel.pendingHandle = { fd: fds[0] };
            closeFds(fds.slice(1));
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
    writeBuffer(req, data, sendHandle) {
      return queueWrite(req, new Uint8Array(data.buffer, data.byteOffset, data.byteLength), fdsOf(sendHandle));
    },
    writeUtf8String(req, string, sendHandle) {
      return queueWrite(req, encoder.encode(string), fdsOf(sendHandle));
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
      waiting?.abort();
      waiting = null;
      const dropped = writes.splice(0);
      for (const { bytes } of dropped) channel.writeQueueSize -= bytes.length;
      const during = timers?.inCheck?.();
      const cancel = () => dropped.forEach(({ req }) => complete(req, -125));
      if (dropped.length) queueMicrotask(() => (timers?.afterCheck ? timers.afterCheck(cancel, during) : cancel()));
      if (!writing) shut();
    },
  };

  const shut = () => {
    exitFlush?.delete(flushSync);
    ctx.close(fd).catch(() => {});
  };

  function queueWrite(req, bytes, fds) {
    if (closed && !writing) return -32; // UV_EPIPE
    if (tryWrite && !writing && writes.length === 0) {
      let taken = 0;
      try {
        taken = put(bytes, fds);
        fds = undefined;
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
    writes.push({ req, bytes, fds });
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
  // is lost, as Node loses it. No send's callback runs: the program is
  // ending, and Node runs none once it is.
  const flushSync = () => {
    if (writing && !tryWrite) return;
    waiting?.abort();
    waiting = null;
    const left = writes.splice(0);
    for (const { bytes, fds } of left) {
      channel.writeQueueSize -= bytes.length;
      try {
        if (!tryWrite) ctx.sync.write(fd, bytes);
        else if (put(bytes, fds) < bytes.length) return;
      } catch {
        if (tryWrite) return;
      }
    }
  };

  // A send's callback that throws doesn't stop the drain: its exception is
  // the program's uncaught one, as from libuv's write callback in Node.
  const complete = (req, status) => {
    try {
      req.oncomplete?.(status);
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
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
        const taken = put(write.bytes, write.fds);
        write.fds = undefined;
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
      complete(write.req, status);
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
      complete(req, status);
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
 * setupChannel(target, channel, serializationMode): Node's. `maybeClose(target)`
 * is the ChildProcess's close count (the process itself has none).
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
  const passing = channel.passesHandles === true;
  let net;
  const getNet = () => (net ??= process._builtin('net'));
  const handleConversion = conversions(getNet);

  let adopting = 0;
  const held = [];
  const settled = () => {
    adopting--;
    while (adopting === 0 && held.length > 0) held.shift()();
  };
  function deliver(message, received) {
    if (adopting > 0) {
      held.push(() => deliver(message, received));
      return;
    }
    if (received) {
      adopting++;
      received.adopted = channel.track(getNet()[kIpc].adopt(received.fd)).catch(() => {
        channel.closeFds([received.fd]);
        return undefined;
      });
      received.settled = settled;
    }
    handleMessage(message, received, isInternal(message));
  }

  let pendingHandle = null;
  initMessageChannel(channel);
  channel.pendingHandle = null;
  channel.onread = function onread(arrayBuffer) {
    const recvHandle = channel.pendingHandle;
    channel.pendingHandle = null;
    if (arrayBuffer) {
      const nread = streamBaseState[kReadBytesOrError];
      const offset = streamBaseState[kArrayBufferOffset];
      const pool = new Uint8Array(arrayBuffer, offset, nread);
      if (recvHandle) pendingHandle = recvHandle;
      for (const message of parseChannelMessages(channel, pool)) {
        if (isInternal(message) && message.cmd === 'NODE_HANDLE') {
          deliver(message, pendingHandle);
          pendingHandle = null;
        } else {
          deliver(message);
        }
      }
    } else if (adopting > 0) {
      held.push(() => channel.onread(undefined));
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

  target.on('internalMessage', function (message, handle) {
    if (message.cmd === 'NODE_HANDLE_ACK' || message.cmd === 'NODE_HANDLE_NACK') {
      if (target._pendingMessage) {
        if (message.cmd === 'NODE_HANDLE_ACK') {
          closePendingHandle(target);
        } else if (target._pendingMessage.retransmissions++ === MAX_HANDLE_RETRANSMISSIONS) {
          closePendingHandle(target);
          process.emitWarning('Handle did not reach the receiving process correctly', 'SentHandleNotReceivedWarning');
        }
      }

      const queue = target._handleQueue;
      target._handleQueue = null;

      if (target._pendingMessage) {
        target._send(target._pendingMessage.message, target._pendingMessage.handle, target._pendingMessage.options, target._pendingMessage.callback);
      }

      for (let i = 0; i < queue.length; i++) {
        const args = queue[i];
        target._send(args.message, args.handle, args.options, args.callback);
      }

      if (!target.connected && target.channel && !target._handleQueue) target._disconnect();

      return;
    }

    if (message.cmd !== 'NODE_HANDLE') return;

    if (!handle) return target._send({ cmd: 'NODE_HANDLE_NACK' }, null, true);

    const obj = handleConversion[message.type];

    handle.adopted
      .then((native) => {
        if (native === undefined) return target._send({ cmd: 'NODE_HANDLE_NACK' }, null, true);
        target._send({ cmd: 'NODE_HANDLE_ACK' }, null, true);
        try {
          Reflect.apply(obj.got, this, [message, native, (sent) => handleMessage(message.msg, sent, isInternal(message.msg))]);
        } catch (err) {
          process.nextTick(() => {
            throw err;
          });
        }
      })
      .finally(handle.settled);
  });

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

    if (handle && !passing) {
      const ex = handlesNotSupported();
      if (typeof callback === 'function') process.nextTick(callback, ex);
      else process.nextTick(() => this.emit('error', ex));
      return false;
    }

    let obj;

    if (handle) {
      message = { cmd: 'NODE_HANDLE', type: null, msg: message };
      const { Socket, Server, [kIpc]: ipc } = getNet();
      if (handle instanceof Socket) message.type = 'net.Socket';
      else if (handle instanceof Server) message.type = 'net.Server';
      else if (handle instanceof ipc.TCP) message.type = 'net.Native';
      else throw ERR_INVALID_HANDLE_TYPE();

      if (this._handleQueue) {
        this._handleQueue.push({ callback, handle, options, message: message.msg });
        return this._handleQueue.length === 1;
      }

      obj = handleConversion[message.type];
      handle = Reflect.apply(obj.send, target, [message, handle, options]);
      if (!handle) message = message.msg;
    } else if (this._handleQueue && !(message && (message.cmd === 'NODE_HANDLE_ACK' || message.cmd === 'NODE_HANDLE_NACK'))) {
      this._handleQueue.push({ callback, handle: null, options, message });
      return this._handleQueue.length === 1;
    }

    const req = {};
    const err = writeChannelMessage(channel, req, message, handle);
    const wasAsyncWrite = streamBaseState[kLastWriteWasAsync];

    if (err === 0) {
      if (handle) {
        this._handleQueue ||= [];
        obj?.postSend?.(message, handle, options, callback, target);
      }
      if (wasAsyncWrite) {
        req.oncomplete = () => {
          control.unrefCounted();
          if (typeof callback === 'function') callback(null);
        };
        control.refCounted();
      } else if (typeof callback === 'function') {
        process.nextTick(callback, null);
      }
    } else {
      obj?.postSend?.(message, handle, options, callback);
      if (!options?.swallowErrors) {
        const code = UV_WRITE_CODES[err] ?? 'EIO';
        const ex = nodeError(Error, code, `write ${code}`);
        ex.errno = err;
        ex.syscall = 'write';
        if (typeof callback === 'function') process.nextTick(callback, ex);
        else process.nextTick(() => this.emit('error', ex));
      }
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

    if (this._pendingMessage) closePendingHandle(this);

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
    if (!target.channel) {
      if (handle?.adopted) handle.adopted.then((native) => native?.close()).finally(handle.settled);
      return;
    }
    process.nextTick(emit, internal ? 'internalMessage' : 'message', message, handle);
  }

  channel.readStart();
  return control;
}

function closePendingHandle(target) {
  target._pendingMessage.handle.close();
  target._pendingMessage = null;
}

function getSocketList(type, worker, key) {
  const sockets = worker[kChannelHandle].sockets[type];
  let socketList = sockets[key];
  if (!socketList) {
    const Construct = type === 'send' ? SocketListSend : SocketListReceive;
    socketList = sockets[key] = new Construct(worker, key);
  }
  return socketList;
}

function conversions(getNet) {
  return {
    'net.Native': {
      send(message, handle) {
        return handle;
      },
      got(message, handle, emit) {
        emit(handle);
      },
    },
    'net.Server': {
      send(message, server) {
        return server._handle;
      },
      got(message, handle, emit) {
        const server = new (getNet().Server)();
        server.listen(handle, () => emit(server));
      },
    },
    'net.Socket': {
      send(message, socket, options) {
        const sent = socket[kIpc]?.(options.keepOpen);
        if (!sent) return undefined;
        if (sent.server) {
          message.key = sent.server._connectionKey;
          const firstTime = !this[kChannelHandle].sockets.send[message.key];
          const socketList = getSocketList('send', this, message.key);
          if (firstTime) sent.server._setupWorker(socketList);
        }
        return sent.tls ? new TLSWrap(sent.handle) : sent.handle;
      },
      postSend(message, handle, options, callback, target) {
        if (handle && !options.keepOpen) {
          if (target) target._pendingMessage = { callback, message, handle, options, retransmissions: 0 };
          else handle.close();
        }
      },
      got(message, handle, emit) {
        const socket = new (getNet().Socket)({ handle, readable: true, writable: true });
        if (message.key) getSocketList('got', this, message.key).add({ socket });
        emit(socket);
      },
    },
  };
}

/** A channel handle on `fd`, with the serialization module's stream_wrap state. */
export function channelOn({ ctx, handles, serialization, fd, process, timers }) {
  const { streamBaseState, kReadBytesOrError, kArrayBufferOffset, kLastWriteWasAsync } = serialization.streamWrap;
  return createChannelHandle({
    ctx,
    handles,
    streamBaseState,
    constants: { kReadBytesOrError, kArrayBufferOffset, kLastWriteWasAsync },
    fd,
    exitFlush: process ? (process._exitFlush ??= new Set()) : undefined,
    timers,
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
