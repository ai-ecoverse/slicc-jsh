/**
 * node:http over net (ctx.net loopback) + IncomingMessage / ServerResponse.
 */
import { EventEmitter } from './events.mjs';

const STATUS_CODES = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

const METHODS = [
  'ACL',
  'BIND',
  'CHECKOUT',
  'CONNECT',
  'COPY',
  'DELETE',
  'GET',
  'HEAD',
  'LINK',
  'LOCK',
  'M-SEARCH',
  'MERGE',
  'MKACTIVITY',
  'MKCALENDAR',
  'MKCOL',
  'MOVE',
  'NOTIFY',
  'OPTIONS',
  'PATCH',
  'POST',
  'PROPFIND',
  'PROPPATCH',
  'PURGE',
  'PUT',
  'REBIND',
  'REPORT',
  'SEARCH',
  'SOURCE',
  'SUBSCRIBE',
  'TRACE',
  'UNBIND',
  'UNLINK',
  'UNLOCK',
  'UNSUBSCRIBE',
];

function headerObj(rawHeaders) {
  const out = Object.create(null);
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const k = String(rawHeaders[i]).toLowerCase();
    const v = String(rawHeaders[i + 1]);
    if (out[k] === undefined) out[k] = v;
    else if (Array.isArray(out[k])) out[k].push(v);
    else out[k] = [out[k], v];
  }
  return out;
}

function indexOfBytes(haystack, needle, from = 0) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const HEAD_SEP = new Uint8Array([13, 10, 13, 10]); // \r\n\r\n

/** Parse HTTP/1.x head from a byte buffer; returns null if incomplete. */
function parseHead(buf, Buffer) {
  const bytes = buf instanceof Uint8Array ? buf : Buffer.from(buf);
  const idx = indexOfBytes(bytes, HEAD_SEP);
  if (idx === -1) return null;
  const head = Buffer.from(bytes.subarray(0, idx)).toString('latin1');
  const bodyPrefix = Buffer.from(bytes.subarray(idx + 4));
  const lines = head.split('\r\n');
  const requestLine = lines[0];
  const m = /^(?<method>\S+)\s+(?<url>\S+)\s+HTTP\/(?<version>\d+\.\d+)$/.exec(requestLine);
  const statusM = /^HTTP\/(?<version>\d+\.\d+)\s+(?<status>\d{3})(?:\s+(?<reason>.*))?$/.exec(
    requestLine
  );
  const rawHeaders = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    rawHeaders.push(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  if (m) {
    return {
      kind: 'request',
      method: m.groups.method,
      url: m.groups.url,
      httpVersion: m.groups.version,
      rawHeaders,
      bodyPrefix,
    };
  }
  if (statusM) {
    return {
      kind: 'response',
      statusCode: Number(statusM.groups.status),
      statusMessage: statusM.groups.reason ?? STATUS_CODES[Number(statusM.groups.status)] ?? '',
      httpVersion: statusM.groups.version,
      rawHeaders,
      bodyPrefix,
    };
  }
  return { kind: 'error', message: 'Parse Error' };
}

/** Max buffered HTTP body (request or response). Over → 413 / error. */
export const MAX_HTTP_BODY = 64 * 1024 * 1024;

const CRLF = new Uint8Array([13, 10]);

function decodeChunked(body, Buffer, maxBytes = MAX_HTTP_BODY) {
  const parts = [];
  let state = body;
  let total = 0;
  for (;;) {
    const i = indexOfBytes(state, new Uint8Array([13, 10]));
    if (i === -1) break;
    const size = parseInt(Buffer.from(state.subarray(0, i)).toString(), 16);
    if (Number.isNaN(size)) break;
    const need = i + 2 + size + 2;
    if (state.length < need) break;
    if (size === 0) {
      return { ok: true, body: Buffer.concat(parts) };
    }
    total += size;
    if (total > maxBytes) return { ok: false, tooLarge: true };
    parts.push(Buffer.from(state.subarray(i + 2, i + 2 + size)));
    state = state.subarray(need);
  }
  return { ok: false };
}

/** HEAD / 1xx / 204 / 304 never carry a response body (RFC 9110). */
function responseHasNoBody(method, statusCode) {
  if (String(method || 'GET').toUpperCase() === 'HEAD') return true;
  if (statusCode === 204 || statusCode === 304) return true;
  if (statusCode >= 100 && statusCode < 200) return true;
  return false;
}

export function createHttp({ ctx, process, Buffer, handles, getStream, net }) {
  void ctx;
  void process;
  const stream = getStream();
  const { Readable, Writable } = stream;

  function makeIncomingMessage(socket, body) {
    const res = new Readable({
      read() {
        /* body is push()'d below; buffered until a consumer reads */
      },
    });
    res.socket = socket;
    res.connection = socket;
    res.httpVersion = '1.1';
    res.httpVersionMajor = 1;
    res.httpVersionMinor = 1;
    res.headers = Object.create(null);
    res.rawHeaders = [];
    res.method = undefined;
    res.url = undefined;
    res.statusCode = undefined;
    res.statusMessage = undefined;
    res.complete = true;
    res.setTimeout = () => res;
    // Plain Readable push — drainLoop checkpoints nextTick after net I/O wakes.
    if (body && body.length) res.push(body);
    res.push(null);
    handles?.notify?.();
    return res;
  }

  class ServerResponse extends Writable {
    #socket;
    #headers = Object.create(null);
    #headersSent = false;
    #chunked = false;
    #chunks = [];
    statusCode = 200;
    statusMessage = undefined;
    headersSent = false;
    finished = false;
    sendDate = true;

    constructor(req) {
      super();
      this.req = req;
      this.#socket = req.socket;
      this.socket = req.socket;
    }

    // Node's ERR_HTTP_HEADERS_SENT once the head is on the wire.
    #headersSentError(what) {
      const err = new Error(`Cannot ${what} headers after they are sent to the client`);
      err.code = 'ERR_HTTP_HEADERS_SENT';
      return err;
    }

    setHeader(name, value) {
      if (this.#headersSent) throw this.#headersSentError('set');
      this.#headers[String(name).toLowerCase()] = Array.isArray(value) ? value.map(String) : String(value);
      return this;
    }
    getHeader(name) {
      return this.#headers[String(name).toLowerCase()];
    }
    getHeaders() {
      return { ...this.#headers };
    }
    removeHeader(name) {
      if (this.#headersSent) throw this.#headersSentError('remove');
      delete this.#headers[String(name).toLowerCase()];
    }
    hasHeader(name) {
      return Object.prototype.hasOwnProperty.call(this.#headers, String(name).toLowerCase());
    }
    writeHead(statusCode, statusMessage, headers) {
      if (this.#headersSent) throw this.#headersSentError('write');
      this.statusCode = statusCode;
      if (typeof statusMessage === 'string') this.statusMessage = statusMessage;
      else if (statusMessage && typeof statusMessage === 'object') headers = statusMessage;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
      }
      return this;
    }

    /**
     * Node's: a write() before end() sends the head then (chunked, unless a
     * Content-Length was set) and each chunk as it comes, as SSE and
     * long-poll servers need; end() alone sends one framed response.
     */
    #streamed = false;
    #wrote = false;

    write(chunk, encoding, callback) {
      this.#wrote = true;
      return super.write(chunk, encoding, callback);
    }

    flushHeaders() {
      if (!this.#headersSent) this.#sendHead(true);
    }

    #sendHead(streaming) {
      const noBody = responseHasNoBody(this.req?.method, this.statusCode);
      if (streaming) {
        this.#streamed = true;
        if (!noBody && !this.hasHeader('content-length') && !this.hasHeader('transfer-encoding')) {
          this.setHeader('Transfer-Encoding', 'chunked');
        }
      }
      if (!this.hasHeader('connection')) this.setHeader('Connection', 'close');
      if (this.sendDate && !this.hasHeader('date')) this.setHeader('Date', new Date().toUTCString());
      if (String(this.getHeader('transfer-encoding') || '').toLowerCase() === 'chunked') this.#chunked = true;
      const reason = this.statusMessage ?? STATUS_CODES[this.statusCode] ?? '';
      let head = `HTTP/1.1 ${this.statusCode} ${reason}\r\n`;
      for (const [k, v] of Object.entries(this.#headers)) {
        if (Array.isArray(v)) for (const item of v) head += `${k}: ${item}\r\n`;
        else head += `${k}: ${v}\r\n`;
      }
      head += '\r\n';
      this.#headersSent = true;
      this.headersSent = true;
      if (streaming) this.#socket.write(Buffer.from(head));
      return Buffer.from(head);
    }

    _write(chunk, encoding, callback) {
      const buf =
        typeof chunk === 'string'
          ? Buffer.from(chunk, encoding)
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : Buffer.from(chunk);
      // The client is gone: writes go nowhere, as Node's.
      if (this.destroyed) {
        callback();
        return;
      }
      if (this.#wrote && !this.#headersSent) this.#sendHead(true);
      if (!this.#streamed) {
        this.#chunks.push(buf);
        callback();
        return;
      }
      if (buf.length === 0 || responseHasNoBody(this.req?.method, this.statusCode)) {
        callback();
        return;
      }
      const framed = this.#chunked ? Buffer.concat([Buffer.from(`${buf.length.toString(16)}\r\n`), buf, Buffer.from('\r\n')]) : buf;
      this.#socket.write(framed, (err) => callback(err));
    }

    #closeAfter(payload, callback) {
      this.#socket.write(payload, (err) => {
        this.finished = true;
        this.emit('finish');
        try {
          this.#socket.unref?.();
          this.#socket.destroy();
        } catch {
          /* ignore */
        }
        callback(err);
      });
    }

    _final(callback) {
      if (this.#streamed) {
        try {
          this.#closeAfter(this.#chunked && !responseHasNoBody(this.req?.method, this.statusCode) ? Buffer.from('0\r\n\r\n') : Buffer.alloc(0), callback);
        } catch (err) {
          callback(err);
        }
        return;
      }
      try {
        const method = this.req?.method;
        const noBody = responseHasNoBody(method, this.statusCode);
        const wouldBeBody = Buffer.concat(this.#chunks);
        const body = noBody ? Buffer.alloc(0) : wouldBeBody;
        // Node: HEAD still announces Content-Length of the would-be body.
        // 204 always omits Content-Length. 304 must not auto-frame a body, but
        // preserves an explicitly supplied Content-Length (selected representation).
        const noAutoLength = this.statusCode === 204 || this.statusCode === 304;
        if (
          !noAutoLength &&
          !this.hasHeader('content-length') &&
          !this.hasHeader('transfer-encoding')
        ) {
          this.setHeader('Content-Length', String(wouldBeBody.length));
        }
        if (this.statusCode === 204) {
          this.removeHeader('content-length');
          this.removeHeader('Content-Length');
        }
        const head = this.#sendHead(false);
        let payload;
        if (this.#chunked && !noBody) {
          const parts = [head];
          if (body.length) {
            parts.push(Buffer.from(`${body.length.toString(16)}\r\n`), body, Buffer.from('\r\n'));
          }
          parts.push(Buffer.from('0\r\n\r\n'));
          payload = Buffer.concat(parts);
        } else {
          payload = Buffer.concat([head, body]);
        }
        this.#closeAfter(payload, callback);
      } catch (err) {
        callback(err);
      }
    }

    end(chunk, encoding, callback) {
      return super.end(chunk, encoding, callback);
    }

    writeContinue() {
      this.#socket.write('HTTP/1.1 100 Continue\r\n\r\n');
    }
  }

  function rejectPayloadTooLarge(socket, onData) {
    // Stop reading; flush 413 via end(); then destroy so the socket does not sit
    // half-open holding an event-loop ref waiting for a peer FIN.
    if (onData) socket.off('data', onData);
    if (socket.destroyed || socket.writableEnded) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      socket.end(
        'HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        () => {
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
        }
      );
    } catch {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  function handleConnection(socket, requestListener, server) {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([
        buf,
        chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(chunk),
      ]);
      if (buf.length > MAX_HTTP_BODY + 64 * 1024) {
        // Cap head+body growth while still reading the request line/headers.
        rejectPayloadTooLarge(socket, onData);
        return;
      }
      const parsed = parseHead(buf, Buffer);
      if (!parsed || parsed.kind === 'error') {
        if (parsed?.kind === 'error') socket.destroy();
        return;
      }
      if (parsed.kind !== 'request') return;
      const headers = headerObj(parsed.rawHeaders);
      const te = String(headers['transfer-encoding'] || '').toLowerCase();
      let body;
      // RFC 9112: if Transfer-Encoding is present, it frames the body (ignore CL).
      if (te.includes('chunked')) {
        const decoded = decodeChunked(parsed.bodyPrefix, Buffer);
        if (decoded.tooLarge) {
          rejectPayloadTooLarge(socket, onData);
          return;
        }
        if (!decoded.ok) return;
        body = decoded.body;
      } else {
        const cl = headers['content-length'] != null ? Number(headers['content-length']) : 0;
        if (!Number.isFinite(cl) || cl < 0) {
          socket.destroy();
          return;
        }
        if (cl > MAX_HTTP_BODY) {
          rejectPayloadTooLarge(socket, onData);
          return;
        }
        if (parsed.bodyPrefix.length < cl) return;
        body = parsed.bodyPrefix.subarray(0, cl);
      }
      socket.off('data', onData);
      const req = makeIncomingMessage(socket, body);
      req.method = parsed.method;
      req.url = parsed.url;
      req.httpVersion = parsed.httpVersion;
      const [maj, min] = parsed.httpVersion.split('.');
      req.httpVersionMajor = Number(maj);
      req.httpVersionMinor = Number(min);
      req.rawHeaders = parsed.rawHeaders;
      req.headers = headers;
      const res = new ServerResponse(req);
      // The client gone before the response ended (an aborted SSE or
      // long-poll): Node's 'close' on both, so the handler can stop.
      const gone = () => {
        if (!res.finished && !res.destroyed) res.destroy();
        if (!req.destroyed) req.destroy();
      };
      socket.once('close', gone);
      // Node (httpAllowHalfOpen false): the client's FIN aborts a response
      // still going, and the server ends its side.
      socket.once('end', () => {
        if (res.finished) return;
        gone();
        try {
          socket.end();
        } catch {
          /* ignore */
        }
      });
      server.emit('request', req, res);
      if (typeof requestListener === 'function') requestListener(req, res);
    };
    socket.on('data', onData);
    socket.on('error', (err) => server.emit('clientError', err, socket));
  }

  class Server extends net.Server {
    // Node: http.Server sockets default allowHalfOpen true (readable property).
    allowHalfOpen = true;

    constructor(options, requestListener) {
      if (typeof options === 'function') {
        requestListener = options;
        options = {};
      }
      // Peer may FIN after the request while we still write the response.
      super({ ...options, allowHalfOpen: true });
      this.#requestListener = requestListener;
      this.on('connection', (socket) => {
        handleConnection(socket, this.#requestListener, this);
      });
    }
    #requestListener;
  }

  function createServer(options, requestListener) {
    return new Server(options, requestListener);
  }

  class Agent extends EventEmitter {
    constructor(options = {}) {
      super();
      this.options = options ?? {};
      this.keepAlive = Boolean(options.keepAlive);
      this.maxSockets = options.maxSockets ?? Infinity;
      this.maxFreeSockets = options.maxFreeSockets ?? 256;
      this.maxTotalSockets = options.maxTotalSockets ?? Infinity;
      this.totalSocketCount = 0;
      this.protocol = options.protocol;
      this.scheduling = options.scheduling ?? 'lifo';
      // Keep-alive pooling is not implemented yet (documented); surface matches Node.
      this.sockets = Object.create(null);
      this.freeSockets = Object.create(null);
      this.requests = Object.create(null);
    }
    /** Idle keep-alive sockets are not pooled yet — no-op close. */
    destroy() {
      for (const name of Object.keys(this.freeSockets)) {
        for (const s of this.freeSockets[name]) {
          try {
            s.destroy?.();
          } catch {
            /* ignore */
          }
        }
        delete this.freeSockets[name];
      }
    }
    getName(options = {}) {
      // Node: `${host}:${port}:${localAddress}` (trailing colon when no localAddress).
      let name = options.host || options.hostname || 'localhost';
      name += ':';
      if (options.port) name += options.port;
      name += ':';
      if (options.localAddress) name += options.localAddress;
      if (options.family === 4 || options.family === 6) name += `:${options.family}`;
      return name;
    }
    createConnection(options, callback) {
      // TCP only: never treat HTTP URL `path` as a UNIX socket path.
      const opts = { ...options };
      if (!opts.socketPath && typeof opts.path === 'string' && opts.path.startsWith('/')) {
        delete opts.path;
      }
      return net.createConnection(opts, callback);
    }
    keepSocketAlive() {
      return false;
    }
    reuseSocket() {
      /* keep-alive reuse not implemented */
    }
    /**
     * Node `_http_agent.js` shape: addRequest → createSocket → createConnection.
     * agent-base@7 overrides createSocket (async connect) and createConnection
     * (returns the stashed socket) — ClientRequest must enter via addRequest.
     */
    addRequest(req, options, port, localAddress) {
      if (typeof options === 'string') {
        options = { host: options, port, localAddress };
      }
      options = { ...options, ...this.options };
      if (options.socketPath) options.path = options.socketPath;

      const name = this.getName(options);
      this.sockets[name] ||= [];

      const free = this.freeSockets[name];
      if (free?.length) {
        const socket = this.scheduling === 'fifo' ? free.shift() : free.pop();
        if (!free.length) delete this.freeSockets[name];
        if (socket && !socket.destroyed) {
          this.reuseSocket(socket, req);
          this.sockets[name].push(socket);
          this.#handoffSocket(req, socket);
          return;
        }
      }

      const sockLen = this.sockets[name].length;
      if (sockLen < this.maxSockets && this.totalSocketCount < this.maxTotalSockets) {
        this.createSocket(req, options, (err, socket) => {
          if (err) {
            this.#handoffSocket(req, null, err);
            return;
          }
          this.#handoffSocket(req, socket);
        });
        return;
      }

      this.requests[name] ||= [];
      this.requests[name].push(req);
    }
    createSocket(req, options, cb) {
      options = { ...options, ...this.options };
      if (options.socketPath) options.path = options.socketPath;
      const name = this.getName(options);
      options._agentKey = name;

      // Connect options: HTTP URL path must not become a UNIX socket path.
      // Keep request `options` intact for getName / agent-base; strip for dial.
      const connectOpts = { ...options };
      if (!connectOpts.socketPath && typeof connectOpts.path === 'string') {
        delete connectOpts.path;
      }

      let settled = false;
      const oncreate = (err, s) => {
        if (settled) return;
        settled = true;
        if (err) return cb(err);
        this.sockets[name] ||= [];
        this.sockets[name].push(s);
        this.totalSocketCount++;
        s.once?.('close', () => this.removeSocket(s, options));
        cb(null, s);
      };

      const newSocket = this.createConnection(connectOpts, oncreate);
      if (newSocket) oncreate(null, newSocket);
    }
    removeSocket(socket, options = {}) {
      const name = options._agentKey || this.getName(options);
      const list = this.sockets[name];
      if (!list) return;
      const i = list.indexOf(socket);
      if (i === -1) return;
      list.splice(i, 1);
      this.totalSocketCount = Math.max(0, this.totalSocketCount - 1);
      if (!list.length) delete this.sockets[name];

      const pending = this.requests[name];
      if (pending?.length) {
        const req = pending.shift();
        if (!pending.length) delete this.requests[name];
        this.createSocket(req, options, (err, s) => {
          if (err) this.#handoffSocket(req, null, err);
          else this.#handoffSocket(req, s);
        });
      }
    }
    #handoffSocket(req, socket, err) {
      if (typeof req.onSocket === 'function') {
        req.onSocket(socket, err);
        return;
      }
      if (err) {
        if (req.listenerCount?.('error')) req.emit('error', err);
        return;
      }
      req.emit?.('socket', socket);
    }
  }

  const globalAgent = new Agent();

  class ClientRequest extends Writable {
    #opts;
    #headers = Object.create(null);
    #headersSent = false;
    #ended = false;
    #chunks = [];
    #socket;
    #connected = false;
    /** When content-length is known up front, stream body bytes as written. */
    #streaming = false;

    constructor(options, callback) {
      // Not destroyed when the request is written: the response comes after
      // (destroy() is req.destroy(), see _destroy).
      super({ autoDestroy: false });
      this.#opts = options;
      this.reusedSocket = false;
      for (const [k, v] of Object.entries(options.headers ?? {})) {
        this.#headers[String(k).toLowerCase()] = String(v);
      }
      if (callback) this.once('response', callback);
      queueMicrotask(() => this.#connect());
    }

    setHeader(name, value) {
      this.#headers[String(name).toLowerCase()] = String(value);
      return this;
    }
    getHeader(name) {
      return this.#headers[String(name).toLowerCase()];
    }
    removeHeader(name) {
      delete this.#headers[String(name).toLowerCase()];
    }
    setTimeout() {
      return this;
    }
    abort() {
      this.destroy();
    }

    /** Node ClientRequest.onSocket — Agent delivers the socket here. */
    onSocket(socket, err) {
      if (err) {
        if (this.listenerCount('error')) this.emit('error', err);
        return;
      }
      this.#attachSocket(socket);
    }

    #connect() {
      const opts = this.#opts;
      const host = opts.hostname ?? opts.host ?? '127.0.0.1';
      const port = Number(opts.port ?? (opts.protocol === 'https:' ? 443 : 80));
      const options = {
        host,
        hostname: host,
        port,
        method: (opts.method ?? 'GET').toUpperCase(),
        path: opts.path ?? '/',
        protocol: opts.protocol,
      };
      if (opts.socketPath) options.socketPath = opts.socketPath;
      if (opts.localAddress) options.localAddress = opts.localAddress;
      if (opts.family) options.family = opts.family;

      const agent = opts.agent === false ? undefined : (opts.agent ?? globalAgent);
      if (!agent) {
        const connectOpts = { host, port };
        if (options.socketPath) connectOpts.path = options.socketPath;
        this.#attachSocket(net.connect(connectOpts));
        return;
      }
      // Node / agent-base: must enter through addRequest → createSocket → createConnection.
      agent.addRequest(this, options);
    }

    #attachSocket(socket) {
      this.#socket = socket;
      const method = (this.#opts.method ?? 'GET').toUpperCase();
      let headBuf = Buffer.alloc(0);
      let socketEnded = false;
      let emitted = false;

      socket.on('error', (err) => {
        if (emitted) return;
        if (this.listenerCount('error')) this.emit('error', err);
        else socket.destroy();
      });
      const onReady = () => {
        this.#connected = true;
        this.emit('socket', socket);
        // With Content-Length: send headers + any buffered body and stream the rest.
        // Without: wait for end() and send one framed request (buffer until end).
        if (this.#headers['content-length'] != null || this.#ended) {
          this.#flushHeadersAndBufferedBody();
        }
      };
      // Already connected (agent-base may hand off an open socket or generic Duplex
      // with no `connecting` property and no future 'connect' event).
      if (socket.connecting !== true && socket.readable !== false) {
        queueMicrotask(onReady);
      } else {
        socket.on('connect', onReady);
      }

      // Node's client: 'response' at the head, the body streamed as it
      // arrives (Content-Length, chunked, or until the peer's FIN), the
      // socket paused while the response's buffer is full.
      let res = null;
      let finished = false;
      let framing = null; // { kind: 'none' | 'length' | 'chunked' | 'eof', left, buf, state }
      const quietClose = () => {
        socket.removeAllListeners('data');
        socket.removeAllListeners('end');
        socket.removeAllListeners('close');
        socket.removeAllListeners('error');
        socket.on('error', () => {});
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        handles?.notify?.();
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        res.complete = true;
        res.push(null);
        quietClose();
      };
      // A body cut short (the peer gone, or req.destroy()): Node's 'aborted'.
      const abortBody = (err) => {
        if (finished || !res) return;
        finished = true;
        res.emit('aborted');
        res.destroy(err ?? Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
        quietClose();
      };
      this.#abortBody = abortBody;
      const deliver = (bytes) => {
        if (bytes.length === 0 || finished) return;
        if (!res.push(bytes)) socket.pause?.();
        handles?.notify?.();
      };
      const feed = (bytes) => {
        const f = framing;
        if (f.kind === 'length') {
          const take = bytes.subarray(0, f.left);
          f.left -= take.length;
          deliver(take);
          if (f.left === 0) finish();
          return;
        }
        if (f.kind === 'eof') {
          deliver(bytes);
          return;
        }
        // chunked: size line, data, CRLF, …, the 0 chunk and its trailers.
        f.buf = f.buf.length ? Buffer.concat([f.buf, bytes]) : bytes;
        for (;;) {
          if (f.state === 'size') {
            const i = indexOfBytes(f.buf, CRLF);
            if (i === -1) return;
            const size = parseInt(Buffer.from(f.buf.subarray(0, i)).toString().split(';')[0].trim(), 16);
            if (Number.isNaN(size)) {
              abortBody(Object.assign(new Error('Parse Error: Invalid character in chunk size'), { code: 'HPE_INVALID_CHUNK_SIZE' }));
              return;
            }
            f.buf = f.buf.subarray(i + 2);
            f.left = size;
            f.state = size === 0 ? 'trailer' : 'data';
          } else if (f.state === 'data') {
            if (f.buf.length === 0) return;
            const take = f.buf.subarray(0, f.left);
            f.left -= take.length;
            f.buf = f.buf.subarray(take.length);
            deliver(Buffer.from(take));
            if (f.left > 0) return;
            f.state = 'crlf';
          } else if (f.state === 'crlf') {
            if (f.buf.length < 2) return;
            f.buf = f.buf.subarray(2);
            f.state = 'size';
          } else {
            // Trailers end with an empty line.
            const i = indexOfBytes(f.buf, CRLF);
            if (i === -1) return;
            const line = f.buf.subarray(0, i);
            f.buf = f.buf.subarray(i + 2);
            if (line.length === 0) {
              finish();
              return;
            }
          }
        }
      };

      socket.on('data', (chunk) => {
        const bytes = chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(chunk);
        if (res) {
          feed(bytes);
          return;
        }
        headBuf = Buffer.concat([headBuf, bytes]);
        const parsed = parseHead(headBuf, Buffer);
        if (!parsed) return;
        if (parsed.kind !== 'response') {
          this.emit('error', new Error(parsed.message ?? 'Parse Error'));
          socket.destroy();
          return;
        }
        const headers = headerObj(parsed.rawHeaders);
        const te = String(headers['transfer-encoding'] || '').toLowerCase();
        const cl = headers['content-length'] != null ? Number(headers['content-length']) : null;
        if (cl != null && (!Number.isFinite(cl) || cl < 0)) {
          this.emit('error', new Error('Invalid Content-Length'));
          socket.destroy();
          return;
        }
        emitted = true;
        res = new Readable({
          read() {
            socket.resume?.();
          },
          // Destroying the response closes the connection (Node's).
          destroy(err, callback) {
            if (!finished) {
              finished = true;
              quietClose();
            }
            callback(err);
          },
        });
        res.socket = socket;
        res.connection = socket;
        res.httpVersion = parsed.httpVersion;
        res.httpVersionMajor = 1;
        res.httpVersionMinor = 1;
        res.statusCode = parsed.statusCode;
        res.statusMessage = parsed.statusMessage;
        res.rawHeaders = parsed.rawHeaders;
        res.headers = headers;
        res.method = undefined;
        res.url = undefined;
        res.complete = false;
        res.setTimeout = () => res;
        res.req = this;
        this.res = res;
        if (responseHasNoBody(method, parsed.statusCode)) framing = { kind: 'none' };
        else if (te.includes('chunked')) framing = { kind: 'chunked', buf: Buffer.alloc(0), state: 'size', left: 0 };
        else if (cl != null) framing = { kind: 'length', left: cl };
        else framing = { kind: 'eof' };
        // A late socket error is the body's.
        socket.removeAllListeners('error');
        socket.on('error', (err) => abortBody(err));
        this.emit('response', res);
        if (framing.kind === 'none' || (framing.kind === 'length' && framing.left === 0)) {
          finish();
          return;
        }
        if (parsed.bodyPrefix?.length) feed(Buffer.from(parsed.bodyPrefix));
      });
      const onEnd = () => {
        if (socketEnded) return;
        socketEnded = true;
        if (!res || finished) return;
        // Framed by the peer's FIN: done; any other framing: cut short.
        if (framing.kind === 'eof') finish();
        else abortBody();
      };
      socket.on('end', onEnd);
      // Fallback: some transports deliver close without a prior readable 'end'.
      socket.on('close', onEnd);
    }

    #abortBody = null;

    _destroy(err, callback) {
      // req.destroy(): the connection goes, and a body still coming is cut short.
      this.#abortBody?.();
      try {
        this.#socket?.destroy?.();
      } catch {
        /* ignore */
      }
      callback(err);
    }

    #writeHead() {
      const opts = this.#opts;
      const method = (opts.method ?? 'GET').toUpperCase();
      const path = opts.path ?? '/';
      const host = opts.hostname ?? opts.host ?? '127.0.0.1';
      const port = Number(opts.port ?? 80);
      if (!this.#headers.host) {
        this.#headers.host = port === 80 || port === 443 ? host : `${host}:${port}`;
      }
      if (!this.#headers.connection) this.#headers.connection = 'close';
      let head = `${method} ${path} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(this.#headers)) head += `${k}: ${v}\r\n`;
      head += '\r\n';
      return Buffer.from(head);
    }

    #flushHeadersAndBufferedBody() {
      if (this.#headersSent || !this.#socket) return;
      this.#headersSent = true;
      const body = Buffer.concat(this.#chunks);
      this.#chunks = [];
      if (this.#headers['content-length'] != null) {
        this.#streaming = true;
      } else if (this.#ended) {
        // Node: a GET / HEAD / DELETE / OPTIONS / TRACE / CONNECT with no body
        // sends no Content-Length (the others send 0).
        const method = (this.#opts.method ?? 'GET').toUpperCase();
        const bodiless = ['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'].includes(method);
        if (body.length > 0 || !bodiless) this.#headers['content-length'] = String(body.length);
      }
      this.#socket.write(Buffer.concat([this.#writeHead(), body]));
    }

    _write(chunk, encoding, callback) {
      const buf =
        typeof chunk === 'string'
          ? Buffer.from(chunk, encoding)
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : Buffer.from(chunk);
      if (this.#headersSent && this.#streaming) {
        this.#socket.write(buf, callback);
        return;
      }
      this.#chunks.push(buf);
      // Content-Length known and socket up: start streaming now.
      if (
        !this.#headersSent &&
        this.#connected &&
        this.#headers['content-length'] != null
      ) {
        this.#flushHeadersAndBufferedBody();
      }
      callback();
    }

    _final(callback) {
      this.#ended = true;
      if (!this.#headersSent) {
        // No Content-Length: buffer until end, then send with computed CL.
        if (this.#connected) this.#flushHeadersAndBufferedBody();
        // else: connect handler will flush once the socket is up
      } else if (this.#chunks.length && this.#streaming) {
        this.#socket.write(Buffer.concat(this.#chunks), callback);
        this.#chunks = [];
        return;
      }
      callback();
    }

    end(chunk, encoding, cb) {
      this.#ended = true;
      return super.end(chunk, encoding, cb);
    }
  }

  function normalizeRequestArgs(input, options, callback) {
    if (typeof input === 'string' || input instanceof URL) {
      const url = new URL(input);
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      options = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: options?.method,
        headers: options?.headers,
        ...options,
      };
    } else if (typeof input === 'object' && input !== null) {
      if (typeof options === 'function') {
        callback = options;
        options = input;
      } else {
        options = input;
      }
    }
    return { options: options ?? {}, callback };
  }

  function request(input, options, callback) {
    const norm = normalizeRequestArgs(input, options, callback);
    return new ClientRequest(norm.options, norm.callback);
  }

  function get(input, options, callback) {
    const req = request(input, options, callback);
    req.end();
    return req;
  }

  return {
    METHODS,
    STATUS_CODES,
    IncomingMessage: function IncomingMessage(socket, body) {
      return makeIncomingMessage(socket, body ?? Buffer.alloc(0));
    },
    ServerResponse,
    Server,
    ClientRequest,
    Agent,
    globalAgent,
    createServer,
    request,
    get,
    maxHeaderSize: 16384,
  };
}
