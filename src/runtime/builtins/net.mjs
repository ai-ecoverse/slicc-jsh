/**
 * node:net over ctx.net (kernel loopback TCP).
 */
import { trackPromise } from '../async-handles.mjs';
import { EventEmitter } from './events.mjs';
import { connectError } from './http-fetch.mjs';
import { validateBoolean, validateInt32 } from '../node-errors.mjs';

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

export function createNet({ ctx, process, Buffer, handles, getStream }) {
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

    constructor(options = {}) {
      // Node net.Socket defaults allowHalfOpen to false. HTTP servers opt in
      // via createServer / Server options so a peer FIN does not end the response.
      // autoDestroy: destroy (and emit one 'close') once both sides finish.
      super({
        allowHalfOpen: Boolean(options.allowHalfOpen),
        autoDestroy: true,
        emitClose: true,
      });
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
      if (this.#handle) handles.add(this.#handle);
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
    _attach(conn) {
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
      // Node net.Socket delivers 'end'/'close' even without a 'data' listener;
      // resume so buffered EOF from #pumpRead is consumed (fin4.js).
      this.resume?.();
      this.emit('connect');
      this.emit('ready');
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
      this.connecting = true;
      this.#connecting = true;
      const host = options.host ?? '127.0.0.1';
      const port = Number(options.port);
      const p = trackPromise(
        handles,
        ctx.net
          .connect({ host, port, signal: options.signal })
          .then((conn) => {
            if (this.destroyed) {
              void conn.close();
              return;
            }
            this._attach(conn);
            for (const chunk of this.#pending) void this.#writer.write(chunk);
            this.#pending = [];
          })
          .catch((err) => {
            this.connecting = false;
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
          if (this.#idleTimer) this._touch();
          if (done) {
            this.#readableEof = true;
            // Yield so prior push(buf) nextTicks can run before EOF.
            await Promise.resolve();
            this.push(null);
            // allowHalfOpen false: auto-end AFTER 'end' listeners so
            // `s.on('end', () => s.end('bye'))` can still write (Node; endreply.js).
            this.#scheduleAutoEnd();
            // Wake drainLoop to flush readable-stream's deferred 'data'/'end'.
            handles.notify();
            break;
          }
          const buf =
            value instanceof Uint8Array
              ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
              : Buffer.from(value);
          // Keep pulling from the kernel stream; readable-stream buffers if paused.
          // Waiting on push()===false deadlocks when the only consumer is 'data'.
          this.push(buf);
          handles.notify();
          await Promise.resolve();
        }
      } catch (err) {
        // Peer half-close/close can race into EBADF; treat as readable EOF when
        // we are not already destroyed so listeners still see 'end'.
        const code = err?.code ?? err?.cause?.code;
        if (!this.destroyed && (code === 'EBADF' || code === 'ECONNRESET' || code === 'EPIPE')) {
          this.#readableEof = true;
          this.push(null);
          this.#scheduleAutoEnd();
          handles.notify();
        } else if (!this.destroyed) {
          this.destroy(errnoError(err, 'read'));
        }
      } finally {
        this.#maybeFinishConn();
      }
    }

    /**
     * Node: with allowHalfOpen false, the writable side ends after the readable
     * 'end' event is delivered — not before — so handlers may still write.
     */
    #scheduleAutoEnd() {
      if (this.allowHalfOpen) return;
      const run = () => {
        const writableEnded = this.writableEnded === true || this._writableState?.ended;
        if (!this.destroyed && !writableEnded && !this.#ended) this.end();
      };
      // After readable-stream's nextTick 'end' emission (and its listeners).
      nextTick(() => nextTick(run));
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
          return;
        }
        callback(new Error('Socket is not connected'));
        return;
      }
      this.#writer.write(bytes).then(
        () => callback(),
        (err) => callback(errnoError(err, 'write'))
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
      this.#writer
        .close()
        .catch(() => {})
        .finally(() => {
          this.#maybeFinishConn();
          callback();
        });
    }

    _destroy(err, callback) {
      this.destroyed = true;
      // Node's Socket._destroy: the server's count drops now, before this
      // socket's 'close' (so a closing server's 'close' comes first).
      const server = this[kServer];
      if (server) {
        this[kServer] = undefined;
        server[kServer]?.();
      }
      if (this.#idleTimer) clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
      const halfClosedCleanly = this.#finishConnStarted;
      this.#finishConnStarted = true;
      this.#dropHandle();
      // Match Node: destroy does not flush. Never await kernel close here —
      // conn.close() can deadlock with a peer blocked in read (fin.js).
      // Duplex emits a single 'close' after this callback (do not emit here).
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

  class Server extends EventEmitter {
    #listener;
    #listening = false;
    #handle;
    #closed = false;
    #acceptAbort;
    #connections = 0;
    #listenerClosed = false;
    listening = false;
    maxConnections = Infinity;

    constructor(options, connectionListener) {
      super();
      if (typeof options === 'function') {
        connectionListener = options;
        options = {};
      }
      this.#options = options ?? {};
      if (connectionListener) this.on('connection', connectionListener);
    }

    #options;

    address() {
      if (!this.#listener) return null;
      return {
        port: this.#listener.port,
        family: 'IPv4',
        address: this.#listener.host || '127.0.0.1',
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

      this.#acceptAbort = new AbortController();
      const host = parsed.host ?? '127.0.0.1';
      const port = parsed.port ?? 0;
      void trackPromise(
        handles,
        ctx.net
          .listen({ port, host, backlog: parsed.backlog })
          .then((listener) => {
            if (this.#closed) {
              void listener.close();
              return;
            }
            this.#listener = listener;
            this.#listening = true;
            this.listening = true;
            this.#handle = { kind: 'server', fd: listener.fd };
            handles.add(this.#handle);
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
            this.emit('error', errnoError(err, 'listen'));
          })
      );
      return this;
    }

    async #acceptLoop() {
      const listener = this.#listener;
      if (!listener) return;
      try {
        for (;;) {
          if (this.#closed) break;
          // The server's handle keeps the loop alive (or not, unref'd): a
          // pending accept is not a handle of its own.
          const conn = await listener.accept({ signal: this.#acceptAbort.signal });
          const socket = new Socket({ allowHalfOpen: Boolean(this.#options.allowHalfOpen) });
          this.#connections++;
          socket[kServer] = this;
          socket._attach(conn);
          this.emit('connection', socket);
          handles.notify();
        }
      } catch (err) {
        if (!this.#closed && err?.name !== 'AbortError') {
          this.emit('error', errnoError(err, 'accept'));
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
      this.#listening = false;
      this.listening = false;
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
      // The kernel's close keeps the loop alive until it is done (Node's
      // handle does, until its close callback).
      trackPromise(handles, Promise.resolve(listener?.close?.()).catch(() => {})).catch(() => {});
      // Node: 'close' on a later tick once every connection has ended
      // (_emitCloseIfDrained), not while one is still open; it doesn't wait
      // for the kernel's close (its fd closes inside close()). The kernel
      // takes a process's requests in order, so a listen() on the same port
      // from the 'close' callback comes after this close.
      this.#listenerClosed = true;
      this.#emitCloseIfDrained();
      return this;
    }

    /** One of this server's connections went (its socket's _destroy). */
    [kServer]() {
      this.#connections--;
      this.#emitCloseIfDrained();
    }

    #emitCloseIfDrained() {
      if (!this.#listenerClosed || this.#connections > 0) return;
      this.#listenerClosed = false;
      nextTick(() => this.emit('close'));
    }

    ref() {
      if (this.#handle) handles.add(this.#handle);
      return this;
    }
    unref() {
      if (this.#handle) handles.delete(this.#handle);
      return this;
    }

    getConnections(cb) {
      // Node's: the count, on a later tick.
      if (typeof cb === 'function') nextTick(cb, null, this.#connections);
      return this;
    }
  }

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
