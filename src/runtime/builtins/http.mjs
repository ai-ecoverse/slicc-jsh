/**
 * node:http over net (ctx.net loopback) + IncomingMessage / ServerResponse.
 */
import { trackPromise } from '../async-handles.mjs';
import { ERR_OUT_OF_RANGE, nodeError, validateInteger } from '../node-errors.mjs';
import { EventEmitter } from './events.mjs';
import { createFetchClient, isLoopbackHost } from './http-fetch.mjs';

// Node 22's table (lib/_http_server.js), in its order.
const STATUS_CODES = {
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a Teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Entity',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  509: 'Bandwidth Limit Exceeded',
  510: 'Not Extended',
  511: 'Network Authentication Required',
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
      // As the server sent it (Node's parser doesn't look it up).
      statusMessage: statusM.groups.reason ?? '',
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
      return { ok: true, body: Buffer.concat(parts), used: body.length - state.length + need };
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

export function createHttp({ ctx, process, Buffer, handles, getStream, net, getFetch }) {
  void ctx;
  void process;
  const stream = getStream();
  const { Readable, Writable } = stream;
  let fetchClient;
  const getFetchClient = () => (fetchClient ??= createFetchClient({ ctx, Buffer, getStream, handles, STATUS_CODES, getFetch }));

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
    // The names as set (Node writes them so), by their lower-case key.
    #names = Object.create(null);
    /** Set by the connection: whether this response may leave it open. */
    shouldKeepAlive = false;
    /** @internal Called once the response is on the wire and the connection stays. */
    _onKeptAlive = null;
    /** @internal The server's keepAliveTimeout, for the Keep-Alive header. */
    _keepAliveTimeout = 0;
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
      const key = String(name).toLowerCase();
      this.#headers[key] = Array.isArray(value) ? value.map(String) : String(value);
      this.#names[key] = String(name);
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
      delete this.#names[String(name).toLowerCase()];
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

    #sendHead(streaming, autoLength = null) {
      const noBody = responseHasNoBody(this.req?.method, this.statusCode);
      // HTTP/1.0 has no chunked framing: such a body ends with the connection.
      const http10 = this.req?.httpVersion === '1.0';
      let autoChunked = false;
      if (streaming) {
        this.#streamed = true;
        if (!noBody && !http10 && !this.hasHeader('content-length') && !this.hasHeader('transfer-encoding')) autoChunked = true;
      }
      if (http10) autoLength = null;
      // Node's order: the headers as set, then Date, Connection, Keep-Alive
      // and the framing it adds itself.
      const auto = [];
      if (this.sendDate && !this.hasHeader('date')) auto.push(['Date', new Date().toUTCString()]);
      const framed =
        noBody || autoChunked || autoLength != null || this.hasHeader('content-length') || /chunked/i.test(String(this.getHeader('transfer-encoding') ?? ''));
      if (!framed || /close/i.test(String(this.getHeader('connection') ?? ''))) this.shouldKeepAlive = false;
      if (!this.hasHeader('connection')) {
        auto.push(['Connection', this.shouldKeepAlive ? 'keep-alive' : 'close']);
        if (this.shouldKeepAlive && this._keepAliveTimeout) auto.push(['Keep-Alive', `timeout=${Math.floor(this._keepAliveTimeout / 1000)}`]);
      }
      if (autoLength != null) auto.push(['Content-Length', String(autoLength)]);
      if (autoChunked) auto.push(['Transfer-Encoding', 'chunked']);
      if (autoChunked || String(this.getHeader('transfer-encoding') || '').toLowerCase() === 'chunked') this.#chunked = true;
      // Node's server: the table's phrase, else 'unknown'.
      const reason = this.statusMessage ?? (STATUS_CODES[this.statusCode] || 'unknown');
      let head = `HTTP/1.1 ${this.statusCode} ${reason}\r\n`;
      for (const [k, v] of Object.entries(this.#headers)) {
        const name = this.#names[k] ?? k;
        if (Array.isArray(v)) for (const item of v) head += `${name}: ${item}\r\n`;
        else head += `${name}: ${v}\r\n`;
      }
      for (const [k, v] of auto) head += `${k}: ${v}\r\n`;
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
      // A client gone (EPIPE) isn't the response's error, as Node's: the
      // socket's goes to the server ('clientError'), the response closes.
      this.#socket.write(framed, () => callback());
    }

    #closeAfter(payload, callback) {
      this.#socket.write(payload, () => {
        this.finished = true;
        this.emit('finish');
        if (this.shouldKeepAlive && typeof this._onKeptAlive === 'function' && !this.#socket.destroyed) {
          // Keep-alive: the connection takes its next request, also once
          // close() was called (Node 22: it closes when idle).
          this._onKeptAlive();
        } else if (this._server?._closing && !this.#socket.destroyed) {
          // close() is waiting on a connection that ends with this response:
          // end our side and let the client close its own once it has read
          // the response, so close's callback comes after the client's
          // 'end', as in Node.
          const socket = this.#socket;
          const done = () => {
            clearTimeout(timer);
            try {
              socket.destroy();
            } catch {
              /* ignore */
            }
          };
          const timer = setTimeout(done, 2000);
          timer.unref?.();
          socket.once('end', done);
          socket.once('close', done);
          try {
            socket.end();
          } catch {
            done();
          }
        } else {
          try {
            this.#socket.unref?.();
            this.#socket.destroy();
          } catch {
            /* ignore */
          }
        }
        callback();
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
        const autoLength =
          !noAutoLength && !this.hasHeader('content-length') && !this.hasHeader('transfer-encoding') ? wouldBeBody.length : null;
        if (this.statusCode === 204) {
          this.removeHeader('content-length');
          this.removeHeader('Content-Length');
        }
        const head = this.#sendHead(false, autoLength);
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

  /**
   * One connection of a server, as Node's: requests one after another
   * (pipelined ones queued), the connection kept open after a response that
   * may (HTTP/1.1, no `Connection: close`, a framed body), closed after
   * `keepAliveTimeout` + `keepAliveTimeoutBuffer` idle (Node 22's margin
   * over the announced timeout), or at once by closeIdleConnections(). As in
   * Node, a server that is closing keeps a connection that goes idle after
   * close() until then (or until the client ends it). A request
   * whose headers don't arrive within `headersTimeout` gets 408. An
   * `Upgrade` request goes to 'upgrade' listeners, with the socket.
   */
  function handleConnection(socket, requestListener, server) {
    let buf = Buffer.alloc(0);
    let busy = false;
    let served = 0;
    let idleTimer = null;
    let headersTimer = null;
    const conn = { socket, idle: true };
    server._connections.add(conn);
    let requestTimer = null;
    socket.once('close', () => {
      server._connections.delete(conn);
      clearTimeout(idleTimer);
      clearTimeout(headersTimer);
      clearTimeout(requestTimer);
      server._connectionGone?.();
    });
    const destroy = () => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = null;
      const ms = server.keepAliveTimeout;
      if (ms > 0) {
        idleTimer = setTimeout(destroy, ms + (Number(server.keepAliveTimeoutBuffer) || 0));
        idleTimer.unref?.();
      }
    };
    // Node's 408: the headers within headersTimeout (from the connection, or
    // a kept-alive one's next request), the whole request within requestTimeout.
    const timeout408 = () => {
      if (busy || socket.destroyed) return;
      try {
        socket.end('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n', destroy);
      } catch {
        destroy();
      }
    };
    const armHeaders = () => {
      if (headersTimer || !(server.headersTimeout > 0)) return;
      headersTimer = setTimeout(() => {
        headersTimer = null;
        timeout408();
      }, server.headersTimeout);
      headersTimer.unref?.();
    };
    const armRequest = () => {
      if (requestTimer || !(server.requestTimeout > 0)) return;
      requestTimer = setTimeout(() => {
        requestTimer = null;
        timeout408();
      }, server.requestTimeout);
      requestTimer.unref?.();
    };
    const pump = () => {
      if (busy || socket.destroyed || buf.length === 0) return;
      clearTimeout(idleTimer);
      idleTimer = null;
      armHeaders();
      if (buf.length > MAX_HTTP_BODY + 64 * 1024) {
        // Cap head+body growth while still reading the request line/headers.
        rejectPayloadTooLarge(socket, onData);
        return;
      }
      const parsed = parseHead(buf, Buffer);
      if (!parsed || parsed.kind === 'error') {
        if (parsed?.kind === 'error') destroy();
        return;
      }
      if (parsed.kind !== 'request') return;
      // The headers are in: headersTimeout is done, the body has requestTimeout.
      clearTimeout(headersTimer);
      headersTimer = null;
      armRequest();
      const headers = headerObj(parsed.rawHeaders);
      const te = String(headers['transfer-encoding'] || '').toLowerCase();
      const connectionTokens = String(headers.connection || '').toLowerCase();
      // Node: an Upgrade request goes to 'upgrade' listeners, with what
      // followed the head; with none, it is an ordinary request.
      if (headers.upgrade && /\bupgrade\b/.test(connectionTokens) && server.listenerCount('upgrade') > 0) {
        clearTimeout(headersTimer);
        headersTimer = null;
        clearTimeout(requestTimer);
        requestTimer = null;
        socket.off('data', onData);
        server._connections.delete(conn);
        const req = makeIncomingMessage(socket, Buffer.alloc(0));
        setRequestLine(req, parsed, headers);
        buf = Buffer.alloc(0);
        server.emit('upgrade', req, socket, Buffer.from(parsed.bodyPrefix));
        return;
      }
      let body;
      let used;
      const headLength = buf.length - parsed.bodyPrefix.length;
      // RFC 9112: if Transfer-Encoding is present, it frames the body (ignore CL).
      if (te.includes('chunked')) {
        const decoded = decodeChunked(parsed.bodyPrefix, Buffer);
        if (decoded.tooLarge) {
          rejectPayloadTooLarge(socket, onData);
          return;
        }
        if (!decoded.ok) return;
        body = decoded.body;
        used = headLength + decoded.used;
      } else {
        const cl = headers['content-length'] != null ? Number(headers['content-length']) : 0;
        if (!Number.isFinite(cl) || cl < 0) {
          destroy();
          return;
        }
        if (cl > MAX_HTTP_BODY) {
          rejectPayloadTooLarge(socket, onData);
          return;
        }
        if (parsed.bodyPrefix.length < cl) return;
        body = parsed.bodyPrefix.subarray(0, cl);
        used = headLength + cl;
      }
      clearTimeout(requestTimer);
      requestTimer = null;
      // What follows this request (a pipelined one) waits its turn.
      buf = Buffer.from(buf.subarray(used));
      busy = true;
      conn.idle = false;
      served++;
      const req = makeIncomingMessage(socket, body);
      setRequestLine(req, parsed, headers);
      const res = new ServerResponse(req);
      // Node's shouldKeepAlive: HTTP/1.1 unless the client says close, and
      // below maxRequestsPerSocket. A connection that is open when close()
      // is called keeps serving as before (Node 22): it closes when idle.
      const max = server.maxRequestsPerSocket;
      res.shouldKeepAlive =
        parsed.httpVersion !== '1.0' && !/\bclose\b/.test(connectionTokens) && !(max > 0 && served >= max);
      res._keepAliveTimeout = server.keepAliveTimeout;
      res._server = server;
      // The client gone before the response ended (an aborted SSE or
      // long-poll): Node's 'close' on both, so the handler can stop.
      const gone = () => {
        if (!res.finished && !res.destroyed) res.destroy();
        if (!req.destroyed) req.destroy();
      };
      // Node (httpAllowHalfOpen false): the client's FIN aborts a response
      // still going, and the server ends its side.
      const onEnd = () => {
        if (res.finished) return;
        gone();
        try {
          socket.end();
        } catch {
          /* ignore */
        }
      };
      socket.once('close', gone);
      socket.once('end', onEnd);
      res._onKeptAlive = () => {
        socket.off('close', gone);
        socket.off('end', onEnd);
        busy = false;
        conn.idle = true;
        // The request's 'close' (Node emits it once the response is done).
        if (!req.destroyed) req.destroy();
        if (socket.destroyed) {
          destroy();
          return;
        }
        armIdle();
        queueMicrotask(pump);
      };
      server.emit('request', req, res);
      if (typeof requestListener === 'function') requestListener(req, res);
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(chunk)]);
      pump();
    };
    // The client ends an idle connection: so does the server.
    socket.on('end', () => {
      if (!busy) destroy();
    });
    socket.on('data', onData);
    socket.on('error', (err) => server.emit('clientError', err, socket));
    // A connection that sends nothing still gets headersTimeout's 408.
    armHeaders();
  }

  function setRequestLine(req, parsed, headers) {
    req.method = parsed.method;
    req.url = parsed.url;
    req.httpVersion = parsed.httpVersion;
    const [maj, min] = parsed.httpVersion.split('.');
    req.httpVersionMajor = Number(maj);
    req.httpVersionMinor = Number(min);
    req.rawHeaders = parsed.rawHeaders;
    req.headers = headers;
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
      // Node's options for them (lib/_http_server.js storeHTTPOptions):
      // integers >= 0, and headersTimeout no longer than requestTimeout.
      for (const key of ['requestTimeout', 'headersTimeout', 'keepAliveTimeout', 'keepAliveTimeoutBuffer']) {
        const value = options?.[key];
        if (value === undefined) continue;
        validateInteger(value, key, 0);
        this[key] = value;
      }
      // Node: headersTimeout defaults to min(60 s, requestTimeout).
      if (options?.headersTimeout === undefined) this.headersTimeout = Math.min(60000, this.requestTimeout);
      if (this.requestTimeout > 0 && this.headersTimeout > 0 && this.headersTimeout > this.requestTimeout) {
        throw ERR_OUT_OF_RANGE('headersTimeout', '<= requestTimeout', this.headersTimeout);
      }
      this.on('connection', (socket) => {
        handleConnection(socket, this.#requestListener, this);
      });
    }
    #requestListener;
    // Node 22's defaults.
    keepAliveTimeout = 5000;
    keepAliveTimeoutBuffer = 1000;
    headersTimeout = 60000;
    requestTimeout = 300000;
    maxRequestsPerSocket = 0;
    maxHeadersCount = null;
    timeout = 0;
    /** @internal This server's connections, and whether each is between requests. */
    _connections = new Set();
    _closing = false;
    _connectionGone = null;

    /** Node's: the connections waiting for their next request go now. */
    closeIdleConnections() {
      for (const conn of [...this._connections]) {
        if (conn.idle) {
          this._connections.delete(conn);
          try {
            conn.socket.destroy();
          } catch {
            /* ignore */
          }
        }
      }
    }
    closeAllConnections() {
      for (const conn of [...this._connections]) {
        this._connections.delete(conn);
        try {
          conn.socket.destroy();
        } catch {
          /* ignore */
        }
      }
    }
    /**
     * Node 19+: close() also closes the idle connections; the busy ones stay
     * open after their response, as kept-alive ones do, and the callback
     * waits until every connection has closed.
     */
    close(callback) {
      this._closing = true;
      let cb = typeof callback === 'function' ? callback : null;
      let listenerClosed = false;
      const done = (err) => {
        if (!cb || (!err && (!listenerClosed || this._connections.size > 0))) return;
        const fn = cb;
        cb = null;
        this._connectionGone = null;
        fn(err);
      };
      this._connectionGone = () => done();
      const r = super.close((err) => {
        listenerClosed = true;
        done(err);
      });
      this.closeIdleConnections();
      return r;
    }
    setTimeout(ms, callback) {
      this.timeout = Number(ms) || 0;
      if (typeof callback === 'function') this.on('timeout', callback);
      return this;
    }
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
      this.keepAliveMsecs = options.keepAliveMsecs ?? 1000;
      // Node 22: the margin taken off a server's Keep-Alive timeout hint.
      const buffer = options.agentKeepAliveTimeoutBuffer;
      this.agentKeepAliveTimeoutBuffer = typeof buffer === 'number' && buffer >= 0 && Number.isFinite(buffer) ? buffer : 1000;
      this.sockets = Object.create(null);
      this.freeSockets = Object.create(null);
      this.requests = Object.create(null);
      // Node's _http_agent.js: a socket whose response is done comes back
      // here: to the next queued request, else to the free pool.
      this.on('free', (socket, options) => this.#onFree(socket, options));
    }
    #onFree(socket, options = {}) {
      const name = this.getName(options);
      const queue = this.requests[name];
      if (!socket.destroyed && queue?.length) {
        const req = queue.shift();
        if (!queue.length) delete this.requests[name];
        this.#handoffSocket(req, socket);
        return;
      }
      const free = (this.freeSockets[name] ||= []);
      if (socket.destroyed || !this.keepAlive || !(this.maxFreeSockets > 0) || free.length >= this.maxFreeSockets || !this.keepSocketAlive(socket)) {
        if (!free.length) delete this.freeSockets[name];
        socket.destroy();
        return;
      }
      const list = this.sockets[name];
      const i = list ? list.indexOf(socket) : -1;
      if (i !== -1) list.splice(i, 1);
      if (list && !list.length) delete this.sockets[name];
      free.push(socket);
    }
    /** Node's: every socket, in use or free, goes. */
    destroy() {
      for (const pool of [this.freeSockets, this.sockets]) {
        for (const name of Object.keys(pool)) {
          for (const s of [...pool[name]]) {
            try {
              s.destroy?.();
            } catch {
              /* ignore */
            }
          }
          delete pool[name];
        }
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
    /** Node's: a free socket doesn't keep the program alive, and times out after `timeout`. */
    /**
     * Node 22's: a server's `Keep-Alive: timeout=N` hint, less
     * agentKeepAliveTimeoutBuffer, caps the free socket's timeout; a hint
     * that leaves nothing means the socket can't be reused safely.
     */
    keepSocketAlive(socket) {
      socket.setKeepAlive?.(true, this.keepAliveMsecs);
      socket.unref?.();
      let timeout = this.options.timeout || 0;
      let keep = true;
      const hint = /^timeout=(\d+)/.exec(String(socket._httpMessage?.res?.headers?.['keep-alive'] ?? ''))?.[1];
      if (hint) {
        const ms = Math.max(0, Number.parseInt(hint, 10) * 1000 - this.agentKeepAliveTimeoutBuffer);
        if (ms === 0) keep = false;
        else if (ms < timeout) timeout = ms;
      }
      if (socket.timeout !== timeout) socket.setTimeout?.(timeout);
      return keep;
    }
    reuseSocket(socket, req) {
      req.reusedSocket = true;
      socket.ref?.();
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
        s.on?.('free', () => this.emit('free', s, options));
        // A free socket that idles past the agent's timeout goes (Node's onTimeout).
        s.on?.('timeout', () => {
          if (this.freeSockets[name]?.includes(s)) s.destroy();
        });
        cb(null, s);
      };

      const newSocket = this.createConnection(connectOpts, oncreate);
      if (newSocket) oncreate(null, newSocket);
    }
    removeSocket(socket, options = {}) {
      const name = options._agentKey || this.getName(options);
      // A free socket that closed (the server's keep-alive timeout) leaves the pool.
      const free = this.freeSockets[name];
      const f = free ? free.indexOf(socket) : -1;
      if (f !== -1) {
        free.splice(f, 1);
        if (!free.length) delete this.freeSockets[name];
        this.totalSocketCount = Math.max(0, this.totalSocketCount - 1);
        return;
      }
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

  // Node 22's: keep-alive, LIFO, free sockets closed after 5 s.
  const globalAgent = new Agent({ keepAlive: true, scheduling: 'lifo', timeout: 5000 });

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

    // The names as given (Node writes them so), by their lower-case key.
    #names = Object.create(null);

    constructor(options, callback) {
      // Not destroyed when the request is written: the response comes after
      // (destroy() is req.destroy(), see _destroy).
      super({ autoDestroy: false });
      this.#opts = options;
      this.reusedSocket = false;
      // Node's: what the request is, readable as res.req's.
      this.method = String(options.method ?? 'GET').toUpperCase();
      this.path = options.path ?? '/';
      // Node's stored head: null until it is rendered (_implicitHeader) or sent.
      this._header = null;
      this.host = options.hostname ?? options.host ?? 'localhost';
      this.protocol = options.protocol ?? 'http:';
      for (const [k, v] of Object.entries(options.headers ?? {})) {
        this.#headers[String(k).toLowerCase()] = String(v);
        this.#names[String(k).toLowerCase()] = String(k);
      }
      // Node: keep-alive when the agent keeps sockets (the global agent does).
      const agent = options.agent === false ? null : (options.agent ?? globalAgent);
      this.agent = agent ?? undefined;
      this.shouldKeepAlive = Boolean(agent?.keepAlive);
      // Node's: Host is set here, after the given headers, so an agent's
      // addRequest sees it (http-proxy-agent builds the absolute URL from it).
      if (!this.#headers.host && options.setHost !== false) {
        let hostHeader = String(options.hostname ?? options.host ?? 'localhost');
        const colon = hostHeader.indexOf(':');
        if (colon !== -1 && hostHeader.includes(':', colon + 1) && hostHeader[0] !== '[') hostHeader = `[${hostHeader}]`;
        const defaultPort = options.defaultPort || agent?.defaultPort || 80;
        if (options.port && +options.port !== defaultPort) hostHeader += `:${options.port}`;
        this.#headers.host = hostHeader;
        this.#names.host = 'Host';
      }
      if (callback) this.once('response', callback);
      queueMicrotask(() => this.#connect());
    }

    setHeader(name, value) {
      this.#headers[String(name).toLowerCase()] = String(value);
      this.#names[String(name).toLowerCase()] = String(name);
      return this;
    }
    getHeader(name) {
      return this.#headers[String(name).toLowerCase()];
    }
    removeHeader(name) {
      delete this.#headers[String(name).toLowerCase()];
      delete this.#names[String(name).toLowerCase()];
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
      socket._httpMessage = this;
      const method = (this.#opts.method ?? 'GET').toUpperCase();
      let headBuf = Buffer.alloc(0);
      let socketEnded = false;
      let emitted = false;

      // Only our own listeners come off at the end: an Agent's 'close'
      // listener (removeSocket, which hands the socket's slot to the next
      // queued request) must still hear the socket close.
      const own = [];
      const listen = (event, fn) => {
        socket.on(event, fn);
        own.push([event, fn]);
      };
      const unlisten = (event) => {
        for (let i = own.length - 1; i >= 0; i--) {
          if (event && own[i][0] !== event) continue;
          socket.removeListener(own[i][0], own[i][1]);
          own.splice(i, 1);
        }
      };
      listen('error', (err) => {
        if (emitted) return;
        if (this.#viaFetchOnNoRoute(err)) return;
        if (this.listenerCount('error')) this.emit('error', err);
        else socket.destroy();
        // Node: 'error', then the request's 'close'.
        if (!this.destroyed) this.destroy();
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
        unlisten();
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
        // Keep-alive: a framed response the server didn't end the connection
        // with goes back to the agent ('free'), for the next request.
        const agent = this.agent;
        const reusable =
          agent &&
          this.shouldKeepAlive &&
          framing.kind !== 'eof' &&
          res.httpVersion !== '1.0' &&
          !/\bclose\b/i.test(String(res.headers.connection ?? '')) &&
          !socketEnded &&
          !socket.destroyed &&
          // An agent that didn't make the socket (its own createSocket) has no pool for it.
          socket.listenerCount('free') > 0;
        if (!reusable) {
          quietClose();
          return;
        }
        unlisten();
        this.#socket = null;
        // As Node's: the agent's 'free' handler still sees this request (and
        // its response's Keep-Alive hint) on the socket.
        queueMicrotask(() => {
          if (socket.destroyed) {
            if (socket._httpMessage === this) socket._httpMessage = null;
            return;
          }
          socket.emit('free');
          if (socket._httpMessage === this) socket._httpMessage = null;
          handles?.notify?.();
        });
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

      listen('data', (chunk) => {
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
        // 101 Switching Protocols: Node's 'upgrade' with the response, the
        // socket (the caller's from now on) and what came after the head;
        // with no listener the connection closes.
        if (parsed.statusCode === 101) {
          unlisten();
          this.#socket = null;
          const up = makeIncomingMessage(socket, Buffer.alloc(0));
          up.statusCode = parsed.statusCode;
          up.statusMessage = parsed.statusMessage;
          up.httpVersion = parsed.httpVersion;
          up.rawHeaders = parsed.rawHeaders;
          up.headers = headers;
          if (this.listenerCount('upgrade') > 0) {
            this.emit('upgrade', up, socket, Buffer.from(parsed.bodyPrefix ?? Buffer.alloc(0)));
          } else {
            socket.destroy();
          }
          this.destroy();
          return;
        }
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
        // Node: the request closes once its response has (res 'end', res
        // 'close', then req 'close'), or was cut short.
        res.once('close', () => {
          if (!this.destroyed) this.destroy();
        });
        if (responseHasNoBody(method, parsed.statusCode)) framing = { kind: 'none' };
        else if (te.includes('chunked')) framing = { kind: 'chunked', buf: Buffer.alloc(0), state: 'size', left: 0 };
        else if (cl != null) framing = { kind: 'length', left: cl };
        else framing = { kind: 'eof' };
        // A late socket error is the body's.
        unlisten('error');
        listen('error', (err) => abortBody(err));
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
        // The connection ended before a response (a kept-alive one the
        // server closed meanwhile): Node's 'socket hang up'.
        if (!res && !this.destroyed && this.#connected && !this.#fetchMode) {
          emitted = true;
          const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
          if (this.listenerCount('error')) this.emit('error', err);
          this.destroy();
          quietClose();
          return;
        }
        if (!res || finished) return;
        // Framed by the peer's FIN: done; any other framing: cut short.
        if (framing.kind === 'eof') finish();
        else abortBody();
      };
      listen('end', onEnd);
      // Fallback: some transports deliver close without a prior readable 'end'.
      listen('close', onEnd);
    }

    #abortBody = null;
    #fetchMode = false;
    #fetchSent = false;
    #fetchAbort = null;

    /**
     * The kernel has no route to the host (no uplink, or an address outside
     * its route table: ENOENT / ENETUNREACH from the connect, before a byte
     * went out): send the request through ctx.fetch instead, as https does.
     * Loopback stays the kernel's own; a request with its own agent (a
     * proxy's), a socketPath or no ctx.fetch gets the error.
     */
    #viaFetchOnNoRoute(err) {
      const code = err?.cause?.code ?? err?.code;
      if (this.#fetchMode || this.#headersSent || this.#connected) return false;
      if (code !== 'ENOENT' && code !== 'ENETUNREACH' && code !== 'ENOTFOUND') return false;
      const opts = this.#opts;
      const host = opts.hostname ?? opts.host ?? '127.0.0.1';
      if (isLoopbackHost(host) || opts.socketPath || typeof ctx?.fetch !== 'function') return false;
      // jsh's own agents only: a subclass, or an Agent with its own
      // createConnection / addRequest / createSocket (a proxy's), routes the
      // request somewhere fetch wouldn't.
      const agent = opts.agent;
      const ownAgent =
        agent === undefined ||
        agent === false ||
        agent === globalAgent ||
        (Object.getPrototypeOf(agent ?? {}) === Agent.prototype &&
          !['createConnection', 'addRequest', 'createSocket'].some((k) => Object.prototype.hasOwnProperty.call(agent, k)));
      if (!ownAgent) return false;
      this.#fetchMode = true;
      this.#noRouteError = err;
      try {
        this.#socket?.destroy?.();
      } catch {
        /* ignore */
      }
      this.#socket = null;
      if (this.#ended) this.#sendViaFetch();
      return true;
    }

    #noRouteError = null;

    #sendViaFetch() {
      if (this.#fetchSent) return;
      this.#fetchSent = true;
      const opts = this.#opts;
      const host = opts.hostname ?? opts.host;
      const port = Number(opts.port ?? 80);
      const method = (opts.method ?? 'GET').toUpperCase();
      const body = Buffer.concat(this.#chunks);
      this.#chunks = [];
      this.#headersSent = true;
      this.#fetchAbort = new AbortController();
      const pending = getFetchClient()
        .send({ protocol: 'http:', host, port, path: opts.path ?? '/', method, headers: this.#headers, body, signal: this.#fetchAbort.signal, req: this })
        .then(
          (res) => {
            if (this.destroyed) {
              res.destroy();
              return;
            }
            this.res = res;
            this.emit('response', res);
          },
          (err) => {
            if (this.destroyed) return;
            // No network for fetch either: the connect's own error, as Node gives it.
            const code = err?.cause?.cause?.code ?? err?.cause?.code;
            const e = code === 'ENETUNREACH' && this.#noRouteError ? this.#noRouteError : err;
            if (this.listenerCount('error')) this.emit('error', e);
          }
        );
      if (handles) void trackPromise(handles, pending);
    }

    _destroy(err, callback) {
      // req.destroy(): the connection goes, and a body still coming is cut short.
      this.#fetchAbort?.abort();
      this.#abortBody?.();
      try {
        this.#socket?.destroy?.();
      } catch {
        /* ignore */
      }
      callback(err);
    }

    /**
     * Node's ClientRequest._implicitHeader: render the head as it stands into
     * `_header`. An agent that rewrites `req.path` (http-proxy-agent's
     * absolute URL) calls it; the head sent is rendered again from the same
     * method, path and headers when the request goes out.
     */
    _implicitHeader() {
      if (this._header) {
        const err = new Error('Cannot render headers after they are sent to the client');
        err.code = 'ERR_HTTP_HEADERS_SENT';
        throw err;
      }
      this._header = this.#writeHead().toString('latin1');
    }

    #writeHead() {
      const opts = this.#opts;
      // Node's: the request line is the request's method and path as they are
      // now (an agent may have rewritten the path).
      const method = String(this.method ?? opts.method ?? 'GET').toUpperCase();
      const path = this.path ?? opts.path ?? '/';
      if (/\bclose\b/i.test(String(this.#headers.connection ?? ''))) this.shouldKeepAlive = false;
      if (!this.#headers.connection) {
        this.#headers.connection = this.shouldKeepAlive ? 'keep-alive' : 'close';
        this.#names.connection = 'Connection';
      }
      let head = `${method} ${path} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(this.#headers)) head += `${this.#names[k] ?? k}: ${v}\r\n`;
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
      const head = this.#writeHead();
      this._header = head.toString('latin1');
      this.#socket.write(Buffer.concat([head, body]));
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
      if (this.#fetchMode) {
        this.#sendViaFetch();
        callback();
        return;
      }
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
        // Node's urlToHttpOptions: an IPv6 address without its brackets.
        hostname: url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
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
    validateHeaderName,
    validateHeaderValue,
    setMaxIdleHTTPParsers,
    maxHeaderSize: 16384,
  };
}

// lib/_http_outgoing.js / _http_common.js: the header checks Node exports (got uses them).
const tokenRegExp = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const headerCharRegex = /[^\t\x20-\x7e\x80-\xff]/;

// hideStackFrames wrappers in Node: (...args), length 0.
function validateHeaderName(...args) {
  const [name, label] = args;
  if (typeof name !== 'string' || !name || !tokenRegExp.test(name)) {
    throw nodeError(TypeError, 'ERR_INVALID_HTTP_TOKEN', `${label || 'Header name'} must be a valid HTTP token ["${name}"]`);
  }
}

function validateHeaderValue(...args) {
  const [name, value] = args;
  if (value === undefined) {
    throw nodeError(TypeError, 'ERR_HTTP_INVALID_HEADER_VALUE', `Invalid value "${value}" for header "${name}"`);
  }
  if (headerCharRegex.test(value)) {
    throw nodeError(TypeError, 'ERR_INVALID_CHAR', `Invalid character in header content ["${name}"]`);
  }
}

/** Node's pool of idle HTTP parsers (1000): jsh keeps none, so the size only has Node's check. */
function setMaxIdleHTTPParsers(max) {
  validateInteger(max, 'max', 1);
}
