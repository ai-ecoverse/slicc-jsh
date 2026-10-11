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
  void handles;
  const stream = getStream();
  const { Readable, Writable } = stream;

  function makeIncomingMessage(socket, body) {
    const res = Readable.from(body && body.length ? [body] : []);
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

    setHeader(name, value) {
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
      delete this.#headers[String(name).toLowerCase()];
    }
    hasHeader(name) {
      return Object.prototype.hasOwnProperty.call(this.#headers, String(name).toLowerCase());
    }
    writeHead(statusCode, statusMessage, headers) {
      this.statusCode = statusCode;
      if (typeof statusMessage === 'string') this.statusMessage = statusMessage;
      else if (statusMessage && typeof statusMessage === 'object') headers = statusMessage;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
      }
      return this;
    }

    _write(chunk, encoding, callback) {
      const buf =
        typeof chunk === 'string'
          ? Buffer.from(chunk, encoding)
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : Buffer.from(chunk);
      this.#chunks.push(buf);
      callback();
    }

    _final(callback) {
      try {
        const body = Buffer.concat(this.#chunks);
        if (!this.hasHeader('content-length') && !this.hasHeader('transfer-encoding')) {
          this.setHeader('Content-Length', String(body.length));
        }
        if (!this.hasHeader('connection')) this.setHeader('Connection', 'close');
        if (this.sendDate && !this.hasHeader('date')) {
          this.setHeader('Date', new Date().toUTCString());
        }
        if (String(this.getHeader('transfer-encoding') || '').toLowerCase() === 'chunked') {
          this.#chunked = true;
        }
        const reason = this.statusMessage ?? STATUS_CODES[this.statusCode] ?? '';
        let head = `HTTP/1.1 ${this.statusCode} ${reason}\r\n`;
        for (const [k, v] of Object.entries(this.#headers)) {
          if (Array.isArray(v)) for (const item of v) head += `${k}: ${item}\r\n`;
          else head += `${k}: ${v}\r\n`;
        }
        head += '\r\n';
        this.#headersSent = true;
        this.headersSent = true;
        let payload;
        if (this.#chunked) {
          const parts = [Buffer.from(head)];
          if (body.length) {
            parts.push(Buffer.from(`${body.length.toString(16)}\r\n`), body, Buffer.from('\r\n'));
          }
          parts.push(Buffer.from('0\r\n\r\n'));
          payload = Buffer.concat(parts);
        } else {
          payload = Buffer.concat([Buffer.from(head), body]);
        }
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

  function rejectPayloadTooLarge(socket) {
    // end() (flush via writer.close), not destroy()/abort — the 413 must leave the wire.
    try {
      socket.end(
        'HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
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
        rejectPayloadTooLarge(socket);
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
          rejectPayloadTooLarge(socket);
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
          rejectPayloadTooLarge(socket);
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
      server.emit('request', req, res);
      if (typeof requestListener === 'function') requestListener(req, res);
    };
    socket.on('data', onData);
    socket.on('error', (err) => server.emit('clientError', err, socket));
  }

  class Server extends net.Server {
    constructor(options, requestListener) {
      if (typeof options === 'function') {
        requestListener = options;
        options = {};
      }
      super(options);
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

  class ClientRequest extends Writable {
    #opts;
    #headers = Object.create(null);
    #headersSent = false;
    #ended = false;
    #chunks = [];
    #socket;

    constructor(options, callback) {
      super();
      this.#opts = options;
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

    #connect() {
      const opts = this.#opts;
      const method = (opts.method ?? 'GET').toUpperCase();
      const host = opts.hostname ?? opts.host ?? '127.0.0.1';
      const port = Number(opts.port ?? (opts.protocol === 'https:' ? 443 : 80));
      const socket = net.connect({ host, port });
      this.#socket = socket;
      let headBuf = Buffer.alloc(0);
      let head = null; // { parsed, headers, te, cl }
      let bodyBuf = Buffer.alloc(0);
      let socketEnded = false;
      let emitted = false;

      socket.on('error', (err) => {
        if (emitted) return;
        if (this.listenerCount('error')) this.emit('error', err);
        else socket.destroy();
      });
      socket.on('connect', () => {
        this.emit('socket', socket);
        this.#flush();
      });

      const emitResponse = (body) => {
        if (emitted) return;
        emitted = true;
        socket.removeAllListeners('data');
        socket.removeAllListeners('end');
        // Drop the TCP handle; ignore late read errors from the kernel pump.
        socket.removeAllListeners('error');
        socket.on('error', () => {});
        try {
          socket.unref?.();
          socket.destroy();
        } catch {
          /* ignore */
        }
        const res = makeIncomingMessage(null, body);
        res.statusCode = head.parsed.statusCode;
        res.statusMessage = head.parsed.statusMessage;
        res.httpVersion = head.parsed.httpVersion;
        res.rawHeaders = head.parsed.rawHeaders;
        res.headers = head.headers;
        this.emit('response', res);
      };

      const tryEmit = () => {
        if (!head || emitted) return;
        const { te, cl, parsed } = head;
        if (responseHasNoBody(method, parsed.statusCode)) {
          emitResponse(Buffer.alloc(0));
          return;
        }
        if (te.includes('chunked')) {
          const decoded = decodeChunked(bodyBuf, Buffer);
          if (decoded.tooLarge) {
            this.emit('error', Object.assign(new Error('Payload Too Large'), { code: 'ERR_OUT_OF_RANGE' }));
            socket.destroy();
            return;
          }
          if (!decoded.ok) return;
          emitResponse(decoded.body);
          return;
        }
        if (cl != null) {
          if (bodyBuf.length < cl) return;
          emitResponse(bodyBuf.subarray(0, cl));
          return;
        }
        // No Content-Length and not chunked: body framed by peer FIN ('end').
        // Do not idle-guess — if ctx.net never delivers FIN, that is a kernel bug.
        if (!socketEnded) return;
        emitResponse(bodyBuf);
      };

      socket.on('data', (chunk) => {
        const bytes = chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(chunk);
        if (!head) {
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
          const cl =
            headers['content-length'] != null ? Number(headers['content-length']) : null;
          if (cl != null && (!Number.isFinite(cl) || cl < 0)) {
            this.emit('error', new Error('Invalid Content-Length'));
            socket.destroy();
            return;
          }
          if (cl != null && cl > MAX_HTTP_BODY) {
            this.emit(
              'error',
              Object.assign(new Error('Payload Too Large'), { code: 'ERR_OUT_OF_RANGE' })
            );
            socket.destroy();
            return;
          }
          head = { parsed, headers, te, cl };
          bodyBuf = parsed.bodyPrefix;
        } else {
          bodyBuf = Buffer.concat([bodyBuf, bytes]);
          if (bodyBuf.length > MAX_HTTP_BODY) {
            this.emit(
              'error',
              Object.assign(new Error('Payload Too Large'), { code: 'ERR_OUT_OF_RANGE' })
            );
            socket.destroy();
            return;
          }
        }
        tryEmit();
      });
      socket.on('end', () => {
        socketEnded = true;
        tryEmit();
      });
    }

    #flush() {
      if (this.#headersSent || !this.#socket) return;
      this.#headersSent = true;
      const opts = this.#opts;
      const method = (opts.method ?? 'GET').toUpperCase();
      const path = opts.path ?? '/';
      const host = opts.hostname ?? opts.host ?? '127.0.0.1';
      const port = Number(opts.port ?? 80);
      if (!this.#headers.host) {
        this.#headers.host = port === 80 || port === 443 ? host : `${host}:${port}`;
      }
      if (!this.#headers.connection) this.#headers.connection = 'close';
      const body = Buffer.concat(this.#chunks);
      if (!this.#headers['content-length'] && this.#ended) {
        this.#headers['content-length'] = String(body.length);
      }
      let head = `${method} ${path} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(this.#headers)) head += `${k}: ${v}\r\n`;
      head += '\r\n';
      this.#socket.write(Buffer.concat([Buffer.from(head), body]));
    }

    _write(chunk, encoding, callback) {
      const buf =
        typeof chunk === 'string'
          ? Buffer.from(chunk, encoding)
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : Buffer.from(chunk);
      this.#chunks.push(buf);
      callback();
    }

    _final(callback) {
      this.#ended = true;
      this.#flush();
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
    Agent: class Agent extends EventEmitter {},
    globalAgent: new (class Agent extends EventEmitter {})(),
    createServer,
    request,
    get,
    maxHeaderSize: 16384,
  };
}
