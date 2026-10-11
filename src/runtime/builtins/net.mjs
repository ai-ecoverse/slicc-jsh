/**
 * node:net over ctx.net (kernel loopback TCP).
 */
import { trackPromise } from '../async-handles.mjs';
import { EventEmitter } from './events.mjs';

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
  void process;
  const stream = getStream();
  const { Duplex } = stream;

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
      super({ allowHalfOpen: options.allowHalfOpen !== false });
      this.connecting = false;
      this.pending = true;
      this.destroyed = false;
      if (options.fd != null) {
        const err = new Error('slicc-jsh: net.Socket fd option is not supported');
        err.code = 'ERR_NOT_SUPPORTED';
        throw err;
      }
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

    ref() {
      if (this.#handle) handles.add(this.#handle);
      return this;
    }
    unref() {
      if (this.#handle) handles.delete(this.#handle);
      return this;
    }

    setTimeout() {
      return this;
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
            this.destroy(errnoError(err, 'connect'));
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

    async #pumpRead() {
      try {
        for (;;) {
          const { value, done } = await this.#reader.read();
          if (done) {
            this.push(null);
            break;
          }
          const buf =
            value instanceof Uint8Array
              ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
              : Buffer.from(value);
          // Keep pulling from the kernel stream; readable-stream buffers if paused.
          // Waiting on push()===false deadlocks when the only consumer is 'data'.
          this.push(buf);
        }
      } catch (err) {
        if (!this.destroyed) this.destroy(errnoError(err, 'read'));
      } finally {
        // Readable side finished — if writable is also done, drop the ref.
        if (this._writableState?.ended || this.#ended) this.#dropHandle();
      }
    }

    #ended = false;

    _read() {
      this.emit('drain-read');
    }

    _write(chunk, encoding, callback) {
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
      // Full close (not only SHUT_WR): kernel loopback delivers EOF to the peer
      // more reliably when the fd is closed after the last write.
      const finish = () => {
        this.#dropHandle();
        callback();
      };
      const closeConn = () =>
        Promise.resolve(this.#conn?.close?.())
          .catch(() => {})
          .then(finish);
      if (!this.#writer) {
        void closeConn();
        return;
      }
      this.#writer
        .close()
        .catch(() => {})
        .then(closeConn);
    }

    _destroy(err, callback) {
      this.destroyed = true;
      this.#dropHandle();
      const closeConn = this.#conn?.close?.();
      void Promise.resolve(closeConn)
        .catch(() => {})
        .finally(() => {
          callback(err);
          this.emit('close', Boolean(err));
        });
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
              this.emit('error', err);
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
          const conn = await listener.accept({ signal: this.#acceptAbort.signal });
          const socket = new Socket();
          socket._attach(conn);
          if (this.listenerCount('connection') === 0) socket.resume?.();
          this.emit('connection', socket);
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
      void Promise.resolve(listener?.close?.())
        .catch(() => {})
        .finally(() => {
          this.emit('close');
        });
      return this;
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
      cb(null, 0);
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
  };
}
