/**
 * node:net over ctx.net (kernel loopback TCP).
 */
import { trackPromise } from '../async-handles.mjs';
import { EventEmitter } from './events.mjs';
import { connectError } from './http-fetch.mjs';
import { validateBoolean, validateInt32 } from '../node-errors.mjs';
import { queueMicrotask, resourceHere, runInResource } from '../async-context.mjs';

function errnoError(err, syscall) {
  const code = err?.code ?? err?.cause?.code ?? 'EIO';
  const e = new Error(`${syscall} ${code}`);
  e.code = typeof code === 'string' ? code : 'EIO';
  e.errno = e.code;
  e.syscall = syscall;
  e.cause = err;
  return e;
}

function parseListenArgs(args) {
  let port;
  let host;
  let backlog;
  let callback;
  if (args.length === 0) return { port: 0 };
  if (typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
    const opts = args[0];
    callback = typeof args[1] === 'function' ? args[1] : undefined;
    return {
      port: opts.port ?? 0,
      host: opts.host ?? opts.hostname,
      backlog: opts.backlog,
      exclusive: opts.exclusive,
      callback,
      path: opts.path,
    };
  }
  const rest = [...args];
  if (typeof rest[rest.length - 1] === 'function') callback = rest.pop();
  if (typeof rest[0] === 'string' && Number.isNaN(Number(rest[0]))) {
    return { path: rest[0], backlog: rest[1], callback };
  }
  port = rest[0] === undefined ? 0 : Number(rest[0]);
  if (typeof rest[1] === 'string') {
    host = rest[1];
    if (typeof rest[2] === 'number') backlog = rest[2];
  } else if (typeof rest[1] === 'number') {
    backlog = rest[1];
  }
  return { port, host, backlog, callback };
}

/**
 * A connect's TLS request for the kernel (tls.connect's): `{ tls, refused }`,
 * where `tls` goes to ctx.net.connect and `refused(err)` maps the kernel's
 * refusal to the error to give. The connection's TLS session lands on
 * socket[kTlsSession].
 */
export const kConnectTls = Symbol('slicc-jsh.net.connectTls');
export const kTlsSession = Symbol('slicc-jsh.net.tlsSession');
const kRefused = Symbol('slicc-jsh.net.tlsRefused');
/**
 * TLS over an open socket (STARTTLS, slicc-kernel 1.124.0): `socket[kDetach]()`
 * hands over a connected socket's kernel connection (its reads stop, its
 * writes so far are out), and `tlsSocket[kStartTls](parent, request)` runs
 * `ctx.net.connect({ socket, host, tls })` on it: at once, or (`request.lazy`)
 * at the first write, as Node's client TLSSocket does.
 */
export const kDetach = Symbol('slicc-jsh.net.detach');
export const kStartTls = Symbol('slicc-jsh.net.startTls');
export const kStartNow = Symbol('slicc-jsh.net.startNow');
/** A TLS socket's error for a failed read or write (a fatal alert), or undefined for errnoError's. */
export const kIoError = Symbol('slicc-jsh.net.ioError');

/** A server-side socket's server (Node's socket._server), told when the socket goes. */
const kServer = Symbol('slicc-jsh.net.server');

function isIP(input) {
  if (typeof input !== 'string') return 0;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(input)) {
    const parts = input.split('.').map(Number);
    return parts.every((n) => n >= 0 && n <= 255) ? 4 : 0;
  }
  if (input.includes(':')) return 6;
  return 0;
}

export function createNet({ ctx, process, Buffer, handles, getStream, timers = globalThis }) {
  // Ports a server closed while its listen() was pending still holds until
  // the kernel's listen is done and its listener closed: a listen() on one
  // waits for that (Node's address is free once close() returns).
  const releasing = new Map();
  // A listener this side drops (one that came too late, or for a listen()
  // that failed): its close failing is no error of the program's (#686).
  const closeQuietly = (listener) => {
    try {
      Promise.resolve(listener.close?.()).catch(() => {});
    } catch {
      /* a close that throws at once */
    }
  };
  const { setTimeout, clearTimeout } = timers;
  const netOption = (name) => {
    const argv = process?._options ?? process?.execArgv ?? [];
    let value;
    for (const a of argv) {
      if (a === name || a === `--no-${name.slice(2)}`) value = a === name;
      else if (a.startsWith(`${name}=`)) value = a.slice(name.length + 1);
    }
    return value;
  };
  let autoSelectFamilyDefault = netOption('--network-family-autoselection') ?? true;
  let autoSelectFamilyAttemptTimeoutDefault = Number(netOption('--network-family-autoselection-attempt-timeout') ?? 250);
  const stream = getStream();
  const { Duplex } = stream;
  const nextTick =
    typeof process?.nextTick === 'function'
      ? process.nextTick.bind(process)
      : (fn) => queueMicrotask(fn);

  class Socket extends Duplex {
    #conn;
    #reader;
    #writer;
    #connecting = false;
    #pending = [];
    #remoteAddress;
    #remotePort;
    #localAddress;
    #localPort;
    #handle;
    // The last write's promise: what a STARTTLS waits for before the switch.
    #lastWrite = Promise.resolve();
    // Handed to a TLS socket (kDetach): no more reads, writes or events here.
    #detached = false;
    // A TLS socket's handshake to run at its first write (new TLSSocket(socket)).
    #startOnWrite = null;
    // The TLS socket that took the connection: it goes when this one does.
    #owner;
    #emitsClose;
    #resource = { frame: null };

    constructor(options = {}) {
      // Node net.Socket defaults allowHalfOpen to false. HTTP servers opt in
      // via createServer / Server options so a peer FIN does not end the response.
      // autoDestroy: destroy (and emit one 'close') once both sides finish.
      super({
        allowHalfOpen: Boolean(options.allowHalfOpen),
        autoDestroy: true,
        emitClose: false,
      });
      this.#emitsClose = options.emitClose !== false;
      this.connecting = false;
      this.pending = true;
      this.destroyed = false;
      if (options.fd != null) {
        const err = new Error('slicc-jsh: net.Socket fd option is not supported');
        err.code = 'ERR_NOT_SUPPORTED';
        throw err;
      }
      // Node always passes a boolean hadError to 'close'; readable-stream may omit it.
      const origEmit = this.emit.bind(this);
      this.emit = (event, ...args) => {
        if (event === 'close' && (args.length === 0 || args[0] === undefined)) {
          return origEmit('close', false);
        }
        return origEmit(event, ...args);
      };
    }

    get remoteAddress() {
      return this.#remoteAddress;
    }
    get remotePort() {
      return this.#remotePort;
    }
    get localAddress() {
      return this.#localAddress;
    }
    get localPort() {
      return this.#localPort;
    }
    get bytesRead() {
      return this._readableState?.bytesRead ?? 0;
    }
    get bytesWritten() {
      return this._writableState?.length ?? 0;
    }

    #refed = true;
    ref() {
      this.#refed = true;
      if (this.#handle && !this.#readableEof) handles.add(this.#handle);
      return this;
    }
    unref() {
      this.#refed = false;
      if (this.#handle) handles.delete(this.#handle);
      return this;
    }

    #idleMs = 0;
    #idleTimer = null;
    /** Node's socket.setTimeout: 'timeout' after `ms` without activity (0 turns it off). */
    setTimeout(ms, callback) {
      this.#idleMs = Number(ms) || 0;
      if (typeof callback === 'function') {
        if (this.#idleMs > 0) this.once('timeout', callback);
        else this.removeListener('timeout', callback);
      }
      this._touch();
      return this;
    }
    get timeout() {
      return this.#idleMs || undefined;
    }
    /** @internal Activity: restart the idle timer. */
    _touch() {
      if (this.#idleTimer) clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
      if (this.#idleMs > 0 && !this.destroyed) {
        this.#idleTimer = setTimeout(() => {
          this.#idleTimer = null;
          if (!this.destroyed) this.emit('timeout');
        }, this.#idleMs);
        this.#idleTimer.unref?.();
      }
    }
    setNoDelay() {
      return this;
    }
    setKeepAlive() {
      return this;
    }
    address() {
      if (this.#localPort == null) return null;
      return { port: this.#localPort, family: 'IPv4', address: this.#localAddress ?? '127.0.0.1' };
    }

    /** Bind an already-open kernel connection (server accept path). */
    _attach(conn, { quiet = false } = {}) {
      this.#conn = conn;
      this.#remoteAddress = conn.remote?.host;
      this.#remotePort = conn.remote?.port;
      this.#localAddress = conn.local?.host;
      this.#localPort = conn.local?.port;
      this.connecting = false;
      this.pending = false;
      this.#writer = conn.writable.getWriter();
      this.#reader = conn.readable.getReader();
      this.#handle = { kind: 'socket', fd: conn.fd };
      handles.add(this.#handle);
      void this.#pumpRead();
      if (quiet) return;
      runInResource(this.#resource, this.#emitConnect, this, []);
    }

    #emitConnect() {
      this.emit('connect');
      this.emit('ready');
    }

    /** The kernel connection, for a TLS socket to upgrade (see kDetach). */
    async [kDetach](owner) {
      if (!this.#conn || this.#detached) {
        throw Object.assign(new Error('slicc-jsh: the socket has no connection to upgrade'), { code: 'ERR_NOT_SUPPORTED' });
      }
      this.#detached = true;
      this.#owner = owner;
      // What was written in plain text goes out before the handshake.
      await this.#lastWrite.catch(() => {});
      // The pump's pending read ends (a TypeError it ignores); a chunk the
      // kernel is still reading stays queued in the stream for the TLS side.
      try {
        this.#reader?.releaseLock();
      } catch {
        /* ignore */
      }
      try {
        this.#writer?.releaseLock();
      } catch {
        /* ignore */
      }
      this.#reader = undefined;
      this.#writer = undefined;
      this.#dropHandle();
      return this.#conn;
    }

    /**
     * TLS over `parent`, a connected (or connecting) net.Socket. `request` is
     * tls's: `dial()` gives `{ host, tls }` for ctx.net.connect, `check(session)`
     * the error to refuse the session with (`refusedSession(err)` takes it, else
     * the socket is destroyed with it), `refused(err)` maps the kernel's
     * refusal, `secured()` is called once the session is up, and `lazy` waits
     * for the first write (or kStartNow).
     */
    [kStartTls](parent, request) {
      this.#connecting = true;
      this.#resource = resourceHere();
      const run = async () => {
        if (this.destroyed) return;
        const { host, tls } = request.dial();
        const conn = await parent[kDetach](this);
        let secure;
        try {
          secure = await ctx.net.connect({ socket: conn, ...(host ? { host } : {}), tls });
        } catch (err) {
          // The connection is this socket's now: it goes with the failed handshake.
          void conn.close?.().catch(() => {});
          throw request.refused(err) ?? errnoError(err, 'connect');
        }
        if (this.destroyed) {
          void secure.close?.().catch(() => {});
          return;
        }
        this[kTlsSession] = secure.tls;
        const bad = request.check?.(secure.tls);
        if (bad) {
          void secure.close?.().catch(() => {});
          this.connecting = false;
          if (request.refusedSession) {
            // 'secure', whose first listener (Node's onConnectSecure) destroys with it.
            request.refusedSession(bad);
            request.secured?.();
          } else this.destroy(bad);
          return;
        }
        this.connecting = false;
        this.#connecting = false;
        this._attach(secure, { quiet: true });
        for (const chunk of this.#pending) void this.#write(chunk);
        this.#pending = [];
        request.secured?.();
      };
      const go = () =>
        void trackPromise(
          handles,
          run().catch((err) => {
            this.connecting = false;
            if (!this.destroyed) this.destroy(err);
          })
        );
      const start = () => {
        this.#startOnWrite = null;
        // A socket still connecting: the handshake once it has. Waiting
        // keeps nothing alive, as in Node (an unconnected socket has no handle).
        if (parent._isConnected()) go();
        else parent.once('connect', go);
      };
      if (request.lazy) this.#startOnWrite = start;
      else start();
      return this;
    }

    /** A lazy kStartTls's handshake, now. */
    [kStartNow]() {
      this.#startOnWrite?.();
    }

    /** @internal Whether the socket has its kernel connection. */
    _isConnected() {
      return Boolean(this.#conn) && !this.#detached;
    }

    #write(bytes) {
      const p = this.#writer.write(bytes);
      this.#lastWrite = p;
      if (this.#readableEof && this.#refed) trackPromise(handles, p).catch(() => {});
      return p;
    }

    connect(...args) {
      let options;
      let callback;
      if (typeof args[0] === 'object' && args[0] !== null) {
        options = args[0];
        callback = typeof args[1] === 'function' ? args[1] : undefined;
      } else if (typeof args[0] === 'number' || typeof args[0] === 'string') {
        options = { port: Number(args[0]) };
        if (typeof args[1] === 'string') {
          options.host = args[1];
          callback = typeof args[2] === 'function' ? args[2] : undefined;
        } else {
          callback = typeof args[1] === 'function' ? args[1] : undefined;
        }
      } else {
        const err = new TypeError('Invalid connect arguments');
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      if (options.path) {
        const err = new Error('slicc-jsh: unix domain sockets are not supported');
        err.code = 'ERR_NOT_SUPPORTED';
        throw err;
      }
      if (callback) this.once('connect', callback);
      this.#resource = resourceHere();
      this.connecting = true;
      this.#connecting = true;
      const host = options.host ?? '127.0.0.1';
      const port = Number(options.port);
      // Node's: the host connected to (tls's checkServerIdentity falls back on it).
      this._host = host;
      const tlsRequest = options[kConnectTls];
      const dial = (tls) => ctx.net.connect({ host, port, signal: options.signal, ...(tls ? { tls } : {}) });
      let dialled = dial(tlsRequest?.tls);
      // tls's first choice refused (the kernel path for a host the uplink
      // doesn't route): its second.
      if (tlsRequest?.retry) {
        dialled = dialled.catch((err) => {
          if ((err?.code ?? err?.cause?.code) !== 'ENOTSUP') throw err;
          return dial(tlsRequest.retry);
        });
      }
      const p = trackPromise(
        handles,
        dialled
          .then((conn) => {
            if (this.destroyed) {
              void conn.close();
              return;
            }
            // A kernel that ignored the TLS request gave a plain connection:
            // nothing may go out on it.
            if (tlsRequest && !conn.tls) {
              void conn.close();
              throw Object.assign(tlsRequest.refused({ code: 'ENOTSUP' }), { [kRefused]: true });
            }
            if (tlsRequest) {
              this[kTlsSession] = conn.tls;
              // Node's onConnectSecure: a peer it won't take gets nothing.
              const bad = tlsRequest.check?.(conn.tls);
              if (bad) {
                void conn.close();
                this.connecting = false;
                this.#connecting = false;
                this.emit('connect');
                if (tlsRequest.refusedSession) tlsRequest.refusedSession(bad);
                else this.destroy(bad);
                return;
              }
            }
            this._attach(conn);
            for (const chunk of this.#pending) void this.#write(chunk);
            this.#pending = [];
          })
          .catch((err) => {
            this.connecting = false;
            if (err?.[kRefused]) {
              this.destroy(err);
              return;
            }
            // What the kernel won't carry over TLS (tls.connect's to say).
            const refusal = tlsRequest?.refused(err);
            if (refusal) {
              this.destroy(refusal);
              return;
            }
            // Node's shapes: getaddrinfo ENOTFOUND <name> for a name the
            // kernel can't resolve, connect <CODE> <host>:<port> otherwise.
            this.destroy(connectError(err?.code ?? err?.cause?.code ?? 'EIO', host, port, err));
          })
      );
      void p;
      return this;
    }

    #dropHandle() {
      if (this.#handle) {
        handles.delete(this.#handle);
        this.#handle = undefined;
      }
    }

    /**
     * When both directions are done, keep the ref for a couple of turns so the
     * peer can observe our SHUT_WR (raw ctx.net delivers EOF from writer.close
     * alone — do not conn.close() here; that races the peer's read).
     */
    #maybeFinishConn() {
      if (this.destroyed || this.#finishConnStarted) return;
      const writableDone = this._writableState?.ended === true || this.#ended;
      if (!this.#readableEof || !writableDone) return;
      this.#finishConnStarted = true;
      const p = new Promise((r) => setTimeout(r, 0))
        .then(() => new Promise((r) => setTimeout(r, 0)))
        .finally(() => {
          this.#dropHandle();
          handles.notify();
        });
      void trackPromise(handles, p);
    }

    #finishConnStarted = false;
    #readableEof = false;

    async #pumpRead() {
      try {
        for (;;) {
          // Track each read so settlement notifies drainLoop (socket handle alone
          // stays ref'd and would not wake waitForProgress).
          // An unref'd socket (an idle keep-alive one) doesn't keep the program alive.
          const reading = this.#reader.read();
          const { value, done } = await (this.#refed ? trackPromise(handles, reading) : reading);
          if (this.#detached) return;
          if (this.#idleTimer) this._touch();
          if (done) {
            this.#readableEof = true;
            // Yield so prior push(buf) nextTicks can run before EOF.
            await Promise.resolve();
            runInResource(this.#resource, this.#endRead, this, []);
            break;
          }
          const buf =
            value instanceof Uint8Array
              ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
              : Buffer.from(value);
          // Keep pulling from the kernel stream; readable-stream buffers if paused.
          // Waiting on push()===false deadlocks when the only consumer is 'data'.
          runInResource(this.#resource, this.push, this, [buf]);
          handles.notify();
          await Promise.resolve();
        }
      } catch (err) {
        // Handed to a TLS socket: its reader was released, nothing ended.
        if (this.#detached) return;
        // Peer half-close/close can race into EBADF; treat as readable EOF when
        // we are not already destroyed so listeners still see 'end'.
        const code = err?.code ?? err?.cause?.code;
        if (!this.destroyed && (code === 'EBADF' || code === 'ECONNRESET' || code === 'EPIPE')) {
          this.#readableEof = true;
          runInResource(this.#resource, this.#endRead, this, []);
        } else if (!this.destroyed) {
          runInResource(this.#resource, this.destroy, this, [this[kIoError]?.(err) ?? errnoError(err, 'read')]);
        }
      } finally {
        if (!this.#detached) this.#maybeFinishConn();
      }
    }

    #endRead() {
      if (this.#handle) {
        handles.delete(this.#handle);
        if (this.#refed) trackPromise(handles, this.#lastWrite).catch(() => {});
      }
      this.push(null);
      this.read(0);
      // Wake drainLoop to flush readable-stream's deferred 'data'/'end'.
      handles.notify();
    }

    #ended = false;

    _read() {
      this.emit('drain-read');
    }

    _write(chunk, encoding, callback) {
      if (this.#idleTimer) this._touch();
      const bytes =
        typeof chunk === 'string'
          ? Buffer.from(chunk, encoding)
          : chunk instanceof Uint8Array
            ? chunk
            : Buffer.from(chunk);
      if (!this.#writer) {
        if (this.#connecting) {
          this.#pending.push(bytes);
          callback();
          this.#startOnWrite?.();
          return;
        }
        callback(new Error('Socket is not connected'));
        return;
      }
      this.#write(bytes).then(
        () => callback(),
        (err) => callback(this[kIoError]?.(err) ?? errnoError(err, 'write'))
      );
    }

    _final(callback) {
      this.#ended = true;
      // Half-close the send side only (Node socket.end / SHUT_WR). Raw ctx.net
      // delivers reader `done` to the peer after writer.close(); also calling
      // conn.close() here races and often surfaces as EBADF on the peer instead
      // of a clean EOF (see scripts/run-raw-ctx-net-fin.mjs).
      if (!this.#writer) {
        this.#maybeFinishConn();
        callback();
        return;
      }
      const closing = this.#writer
        .close()
        .catch(() => {})
        .finally(() => {
          this.#maybeFinishConn();
          callback();
        });
      this.#lastWrite = closing;
      if (this.#readableEof && this.#refed) trackPromise(handles, closing).catch(() => {});
    }

    _destroy(err, done) {
      this.destroyed = true;
      let callback = done;
      if (this.#emitsClose) {
        let release;
        trackPromise(handles, new Promise((resolve) => (release = resolve))).catch(() => {});
        callback = (e) => {
          done(e);
          nextTick(() => {
            release();
            this.emit('close');
          });
        };
      }
      // Node's Socket._destroy: the server's count drops now, before this
      // socket's 'close' (so a closing server's 'close' comes first).
      const server = this[kServer];
      if (server) {
        this[kServer] = undefined;
        server[kServer]?.();
      }
      if (this.#idleTimer) clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
      // Handed to a TLS socket, the connection is that socket's to close.
      if (this.#detached) {
        this.#conn = undefined;
        const owner = this.#owner;
        this.#owner = undefined;
        if (owner && !owner.destroyed) owner.destroy();
        callback(err);
        return;
      }
      const halfClosedCleanly = this.#finishConnStarted;
      this.#finishConnStarted = true;
      this.#dropHandle();
      // Match Node: destroy does not flush. Never await kernel close here —
      // conn.close() can deadlock with a peer blocked in read (fin.js).
      const reader = this.#reader;
      const writer = this.#writer;
      const conn = this.#conn;
      this.#reader = undefined;
      this.#writer = undefined;
      this.#conn = undefined;
      // After a clean half-close, do not abort/cancel — that RSTs the peer and
      // they never see 'end' (fin.js server side). Only force-close on errors.
      if (!halfClosedCleanly) {
        void reader?.cancel?.().catch(() => {});
        try {
          if (typeof writer?.abort === 'function') void writer.abort().catch(() => {});
          else void writer?.close?.().catch(() => {});
        } catch {
          /* ignore */
        }
        void conn?.close?.().catch(() => {});
      }
      callback(err);
    }

    end(data, encoding, callback) {
      if (typeof data === 'function') return super.end(data);
      if (typeof encoding === 'function') return super.end(data, encoding);
      return super.end(data, encoding, callback);
    }
  }

  class TCP {
    #ops;
    constructor(fd, ops) {
      this.reading = false;
      this.fd = fd;
      this.#ops = ops;
    }
    getsockname(out) {
      if (this.#ops.closed()) return -9;
      Object.assign(out, this.#ops.address());
      return 0;
    }
    close(callback) {
      this.#ops.close(callback);
    }
    ref() {
      this.#ops.ref();
    }
    unref() {
      this.#ops.unref();
    }
    hasRef() {
      return this.#ops.hasRef();
    }
  }

  class Server extends EventEmitter {
    #listener;
    #listening = false;
    #handle;
    #closed = false;
    // listen()s the kernel hasn't answered yet (a promise → its port), and
    // those close() took over (it closes their listeners).
    #pendingListens = new Map();
    #takenOver = new WeakSet();
    #acceptAbort;
    #connections = 0;
    #listenerClosed = false;
    // In a cluster worker: the primary's key and address for this server.
    #clusterKey;
    #clusterAddress;
    #unref = false;
    #generation = 0;
    #handleClosed;
    _handle = null;
    maxConnections = Infinity;

    constructor(options, connectionListener) {
      super();
      if (typeof options === 'function') {
        connectionListener = options;
        options = {};
      }
      this.#options = options ?? {};
      this.allowHalfOpen = this.#options.allowHalfOpen || false;
      if (connectionListener) this.on('connection', connectionListener);
    }

    #options;

    address() {
      if (!this.#listener) return null;
      if (this.#handleClosed === this.#listener) throw Object.assign(new Error('address EBADF'), { errno: -9, code: 'EBADF', syscall: 'address' });
      if (this.#clusterAddress) return { ...this.#clusterAddress };
      return {
        address: this.#listener.host || '127.0.0.1',
        family: 'IPv4',
        port: this.#listener.port,
      };
    }

    listen(...args) {
      const parsed = parseListenArgs(args);
      if (parsed.path) {
        const err = new Error('slicc-jsh: unix domain sockets are not supported');
        err.code = 'ERR_NOT_SUPPORTED';
        queueMicrotask(() => this.emit('error', err));
        return this;
      }
      if (this.#listening || this.#listener) {
        const err = new Error('Listen method has been called more than once');
        err.code = 'ERR_SERVER_ALREADY_LISTEN';
        queueMicrotask(() => this.emit('error', err));
        return this;
      }
      if (parsed.callback) this.once('listening', parsed.callback);

      this.#closed = false;
      const generation = ++this.#generation;
      this.#acceptAbort = new AbortController();
      const host = parsed.host ?? '127.0.0.1';
      const port = parsed.port ?? 0;
      // A cluster worker's server (cluster.mjs): it listens on a loopback
      // port of its own, and the primary listens where it asked, joining
      // each connection to it.
      const cluster = !parsed.exclusive && process?._clusterWorker;
      const listening = cluster
        ? ctx.net.listen({ port: 0, host: '127.0.0.1', backlog: parsed.backlog }).then(async (listener) => {
            const reply = await cluster._getServer(this, {
              address: parsed.host ?? null,
              port,
              addressType: 4,
              fd: -1,
              proxy: { port: listener.port },
            });
            if (reply.cancelled) {
              // The channel to the primary went first: no listening, as in Node.
              closeQuietly(listener);
              return null;
            }
            if (reply.errno) {
              closeQuietly(listener);
              const err = new Error(`listen ${reply.errno}: ${reply.message ?? 'address already in use'} ${host}:${port}`);
              err.code = reply.errno;
              err.syscall = 'listen';
              err.address = host;
              err.port = port;
              throw err;
            }
            if (generation !== this.#generation) {
              cluster._closeServer(reply.key);
              return listener;
            }
            this.#clusterKey = reply.key;
            this.#clusterAddress = reply.sockname;
            return listener;
          })
        : port > 0 && releasing.has(port)
          ? releasing.get(port).then(() => ctx.net.listen({ port, host, backlog: parsed.backlog }))
          : ctx.net.listen({ port, host, backlog: parsed.backlog });
      this.#pendingListens.set(listening, port);
      void trackPromise(
        handles,
        listening
          .then((listener) => {
            this.#pendingListens.delete(listening);
            if (!listener) return;
            if (generation !== this.#generation) {
              // Closed meanwhile: close() closes it (and frees its port) if
              // it took this listen() over, else it's closed here.
              if (!this.#takenOver.has(listening)) closeQuietly(listener);
              return;
            }
            this.#listener = listener;
            this.#listening = true;
            this._handle = new TCP(listener.fd, {
              address: () => this.address(),
              close: (callback) => this.#closeHandle(listener, callback),
              closed: () => this.#handleClosed === listener,
              ref: () => this.ref(),
              unref: () => this.unref(),
              hasRef: () => !this.#unref && !!this.#handle,
            });
            this.#handle = { kind: 'server', fd: listener.fd };
            if (!this.#unref) handles.add(this.#handle);
            try {
              this.emit('listening');
            } catch (err) {
              // process.exit() already recorded didExit; do not emit listen EIO.
              if (err?.name === 'NodeExitError') return;
              // Other throws from the listen callback are uncaught, not listen failures.
              nextTick(() => {
                throw err;
              });
              return;
            }
            void this.#acceptLoop();
          })
          .catch((err) => {
            this.emit('error', err?.syscall === 'listen' && cluster ? err : errnoError(err, 'listen'));
          })
      );
      return this;
    }

    async #acceptLoop() {
      const listener = this.#listener;
      if (!listener) return;
      const resource = resourceHere();
      try {
        for (;;) {
          if (this.#closed || this.#listener !== listener || this.#handleClosed === listener) break;
          // The server's handle keeps the loop alive (or not, unref'd): a
          // pending accept is not a handle of its own.
          const conn = await listener.accept({ signal: this.#acceptAbort.signal });
          if (this.#handleClosed === listener) {
            closeQuietly(conn);
            break;
          }
          const socket = new Socket({ allowHalfOpen: Boolean(this.allowHalfOpen) });
          this.#connections++;
          socket[kServer] = this;
          socket._attach(conn);
          runInResource(resource, this.emit, this, ['connection', socket]);
          handles.notify();
        }
      } catch (err) {
        if (!this.#closed && this.#listener === listener && this.#handleClosed !== listener && err?.name !== 'AbortError') {
          runInResource(resource, this.emit, this, ['error', errnoError(err, 'accept')]);
        }
      }
    }

    close(callback) {
      if (callback) this.once('close', callback);
      if (this.#closed) {
        queueMicrotask(() => this.emit('close'));
        return this;
      }
      this.#closed = true;
      this.#generation++;
      this.#listening = false;
      this._handle = null;
      this.#clusterAddress = undefined;
      if (this.#clusterKey !== undefined) {
        process?._clusterWorker?._closeServer(this.#clusterKey);
        this.#clusterKey = undefined;
      }
      // Drop the ref immediately so the event loop can exit even if the kernel
      // accept/close is slow to settle.
      if (this.#handle) {
        handles.delete(this.#handle);
        this.#handle = undefined;
      }
      try {
        this.#acceptAbort?.abort();
      } catch {
        /* ignore */
      }
      const listener = this.#listener;
      this.#listener = undefined;
      // Closed before the kernel's listen()s were done: each listener closes
      // once it comes, and its port is busy until then.
      for (const [pending, port] of this.#pendingListens) {
        this.#takenOver.add(pending);
        const settled = Promise.resolve(
          pending.then(
            (arrived) => arrived?.close?.(),
            () => {}
          )
        ).catch(() => {});
        if (port > 0) {
          releasing.set(port, settled);
          settled.then(() => {
            if (releasing.get(port) === settled) releasing.delete(port);
          });
        }
        trackPromise(handles, settled).catch(() => {});
      }
      this.#pendingListens.clear();
      // The kernel's close keeps the loop alive until it is done (Node's
      // handle does, until its close callback).
      if (listener !== this.#handleClosed) trackPromise(handles, Promise.resolve(listener?.close?.()).catch(() => {})).catch(() => {});
      this.#handleClosed = undefined;
      // Node: 'close' on a later tick once every connection has ended
      // (_emitCloseIfDrained), not while one is still open; it doesn't wait
      // for the kernel's close (its fd closes inside close()). The kernel
      // takes a process's requests in order, so a listen() on the same port
      // from the 'close' callback comes after this close.
      this.#listenerClosed = true;
      this.#emitCloseIfDrained();
      return this;
    }

    #closeHandle(listener, callback) {
      const done = typeof callback === 'function' ? () => callback() : () => {};
      if (this.#listener !== listener || this.#handleClosed === listener) {
        nextTick(done);
        return;
      }
      this.#handleClosed = listener;
      this.#acceptAbort?.abort();
      const handle = this.#handle;
      let closing;
      try {
        closing = Promise.resolve(listener.close?.()).catch(() => {});
      } catch {
        closing = Promise.resolve();
      }
      const closed = closing.then(() => {
        if (handle && this.#handle === handle) {
          handles.delete(handle);
          this.#handle = undefined;
        }
        nextTick(done);
      });
      trackPromise(handles, closed).catch(() => {});
    }

    /** One of this server's connections went (its socket's _destroy). */
    [kServer]() {
      this.#connections--;
      this.#emitCloseIfDrained();
    }

    #emitCloseIfDrained() {
      if (this._handle || !this.#listenerClosed || this.#connections > 0) return;
      this.#listenerClosed = false;
      nextTick(() => this.emit('close'));
    }

    ref() {
      this.#unref = false;
      if (this.#handle) handles.add(this.#handle);
      return this;
    }
    unref() {
      this.#unref = true;
      if (this.#handle) handles.delete(this.#handle);
      return this;
    }

    getConnections(cb) {
      // Node's: the count, on a later tick.
      if (typeof cb === 'function') nextTick(cb, null, this.#connections);
      return this;
    }
  }

  Object.defineProperty(Server.prototype, 'listening', {
    get() {
      return !!this._handle;
    },
    configurable: true,
    enumerable: true,
  });

  function createServer(options, connectionListener) {
    return new Server(options, connectionListener);
  }

  function createConnection(...args) {
    const socket = new Socket();
    return socket.connect(...args);
  }

  return {
    Server,
    Socket,
    createServer,
    createConnection,
    connect: createConnection,
    isIP,
    isIPv4: (s) => isIP(s) === 4,
    isIPv6: (s) => isIP(s) === 6,
    // Node's happy-eyeballs defaults (lib/net.js). The kernel's loopback is
    // IPv4 only, so they choose nothing here; playwright-core reads them at load.
    getDefaultAutoSelectFamily: () => autoSelectFamilyDefault,
    setDefaultAutoSelectFamily(value) {
      validateBoolean(value, 'value');
      autoSelectFamilyDefault = value;
    },
    getDefaultAutoSelectFamilyAttemptTimeout: () => autoSelectFamilyAttemptTimeoutDefault,
    setDefaultAutoSelectFamilyAttemptTimeout(value) {
      validateInt32(value, 'value', 1);
      autoSelectFamilyAttemptTimeoutDefault = value < 10 ? 10 : value;
    },
  };
}
