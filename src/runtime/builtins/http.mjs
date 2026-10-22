/**
 * node:http over net (ctx.net loopback) + IncomingMessage / ServerResponse.
 */
import { trackPromise } from '../async-handles.mjs';
import { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE, nodeError, validateBoolean, validateInteger, validateString } from '../node-errors.mjs';
import { EventEmitter } from './events.mjs';
import { createFetchClient, isLoopbackHost, kIncomingDestroy, kIncomingRead } from './http-fetch.mjs';
import { queueMicrotask, resourceHere, runInResource } from '../async-context.mjs';

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

/**
 * Node's 'error' on a request: with no listener it is the program's
 * uncaught exception (Node's "Unhandled 'error' event"), never dropped, so
 * a program waiting on the request ends instead of waiting forever.
 */
function emitError(emitter, err) {
  try {
    emitter.emit('error', err);
  } catch (thrown) {
    const trigger = globalThis.process?._triggerUncaught;
    if (typeof trigger !== 'function') throw thrown;
    trigger(thrown);
  }
}

/**
 * A write to a kept-alive socket the server has closed fails EPIPE in the
 * kernel; Node's kernel takes the bytes, and on Linux the request ends with
 * the server's FIN as 'socket hang up' (ECONNRESET), which is what Node's
 * retry idiom checks (`req.reusedSocket && err.code === 'ECONNRESET'`).
 */
function resetOfReused(req, err) {
  if (!req.reusedSocket || err?.code !== 'EPIPE') return err;
  return Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
}

function headerObj(rawHeaders) {
  return trailerObj(rawHeaders);
}

// Node's IncomingMessage._addHeaderLine: fields a repeat drops, and the joins.
const SINGLE_FIELDS = new Set([
  'content-type', 'content-length', 'user-agent', 'referer', 'host', 'authorization', 'proxy-authorization',
  'if-modified-since', 'if-unmodified-since', 'from', 'location', 'max-forwards', 'retry-after', 'etag',
  'last-modified', 'server', 'age', 'expires',
]);

/** Node's trailers object (its headers' rules): set-cookie a list, cookie '; ', the rest ', '. */
function trailerObj(rawTrailers) {
  const out = {};
  for (let i = 0; i < rawTrailers.length; i += 2) {
    const k = String(rawTrailers[i]).toLowerCase();
    const v = String(rawTrailers[i + 1]);
    if (k === 'set-cookie') (out[k] ??= []).push(v);
    else if (out[k] === undefined) out[k] = v;
    else if (SINGLE_FIELDS.has(k)) continue;
    else out[k] += k === 'cookie' ? `; ${v}` : `, ${v}`;
  }
  return out;
}

function distinctObj(raw) {
  const out = Object.create(null);
  for (let i = 0; i + 1 < raw.length; i += 2) (out[String(raw[i]).toLowerCase()] ??= []).push(raw[i + 1]);
  return out;
}

const kHeaders = Symbol('kHeaders');
const kHeadersDistinct = Symbol('kHeadersDistinct');
const kTrailers = Symbol('kTrailers');
const kTrailersDistinct = Symbol('kTrailersDistinct');
const kOutHeaders = Symbol('kOutHeaders');
const kSocket = Symbol('kSocket');
const kErrored = Symbol('kErrored');
const kWritableFinished = Symbol('kWritableFinished');
const kNeedDrain = Symbol('kNeedDrain');
const kCorked = Symbol('kCorked');
const kHighWaterMark = Symbol('kHighWaterMark');
const kWriteBody = Symbol('kWriteBody');
const kEndBody = Symbol('kEndBody');
const kFinish = Symbol('kFinish');
const kEmitClose = Symbol('kEmitClose');
const kBytesWritten = Symbol('kBytesWritten');
const kChunkedBuffer = Symbol('kChunkedBuffer');
const kChunkedLength = Symbol('kChunkedLength');
const kBatch = Symbol('kBatch');
const kSocketWrite = Symbol('kSocketWrite');
const kUncorkWire = Symbol('kUncorkWire');
const kDrainWait = Symbol('kDrainWait');
const kOnFree = Symbol('kOnFree');
const kHandoff = Symbol('kHandoff');
const kOpts = Symbol('kOpts');
const kChunks = Symbol('kChunks');
const kConnSocket = Symbol('kConnSocket');
const kConnected = Symbol('kConnected');
const kEnded = Symbol('kEnded');
const kStreaming = Symbol('kStreaming');
const kResource = Symbol('kResource');
const kAbortBody = Symbol('kAbortBody');
const kFetchMode = Symbol('kFetchMode');
const kFetchSent = Symbol('kFetchSent');
const kFetchAbort = Symbol('kFetchAbort');
const kNoRouteError = Symbol('kNoRouteError');
const kConnect = Symbol('kConnect');
const kAttachSocket = Symbol('kAttachSocket');
const kViaFetchOnNoRoute = Symbol('kViaFetchOnNoRoute');
const kSendViaFetch = Symbol('kSendViaFetch');
const kRenderHead = Symbol('kRenderHead');
const kFlushHead = Symbol('kFlushHead');
const kTrackWrite = Symbol('kTrackWrite');
const kMaybeFinish = Symbol('kMaybeFinish');
const kPending = Symbol('kPending');
const kFinishQueued = Symbol('kFinishQueued');
const kRequestListener = Symbol('kRequestListener');
const kFetchTimer = Symbol('kFetchTimer');
export const kFetchVia = Symbol('slicc-jsh.http.fetchVia');
export const httpInternals = new WeakMap();

function setRawHeader(msg, name, value) {
  (msg[kOutHeaders] ??= Object.create(null))[name.toLowerCase()] = [name, value];
}

function rawHeader(msg, key) {
  return msg[kOutHeaders]?.[key]?.[1];
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
function framingError(rawHeaders, packet, bytesParsed) {
  let lengths = 0;
  let chunked = false;
  let reason = null;
  let code = null;
  for (let i = 0; i < rawHeaders.length && !code; i += 2) {
    const key = String(rawHeaders[i]).toLowerCase();
    if (key === 'transfer-encoding') chunked = true;
    if (key !== 'content-length') continue;
    if (++lengths > 1) [code, reason] = ['HPE_UNEXPECTED_CONTENT_LENGTH', 'Duplicate Content-Length'];
    else if (!/^\d+$/.test(rawHeaders[i + 1])) [code, reason] = ['HPE_INVALID_CONTENT_LENGTH', 'Invalid character in Content-Length'];
  }
  if (!code && lengths && chunked) [code, reason] = ['HPE_INVALID_TRANSFER_ENCODING', "Transfer-Encoding can't be present with Content-Length"];
  if (!code) return null;
  return Object.assign(new Error(`Parse Error: ${reason}`), { bytesParsed, code, reason, rawPacket: packet });
}

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
  const error = framingError(rawHeaders, bytes, idx + 4);
  if (m) {
    return {
      error,
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
      error,
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
const RE_CONN_CLOSE = /(?:^|\W)close(?:$|\W)/i;
const RE_TE_CHUNKED = /(?:^|\W)chunked(?:$|\W)/i;

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

export function createHttp({ ctx, process, Buffer, handles, getStream, timers = globalThis, net, getFetch }) {
  const { setTimeout, clearTimeout } = timers;
  void ctx;
  void process;
  const stream = getStream();
  const { Readable } = stream;
  let fetchClient;
  const getFetchClient = () => (fetchClient ??= createFetchClient({ ctx, Buffer, handles, STATUS_CODES, getFetch, IncomingMessage }));

  const Stream = stream.Stream;
  const nop = () => {};

  function IncomingMessage(socket) {
    Readable.call(this, socket ? { highWaterMark: socket.readableHighWaterMark } : undefined);
    this.socket = socket;
    this.httpVersionMajor = null;
    this.httpVersionMinor = null;
    this.httpVersion = null;
    this.complete = false;
    this[kHeaders] = null;
    this.rawHeaders = [];
    this[kTrailers] = null;
    this.rawTrailers = [];
    this.joinDuplicateHeaders = false;
    this.aborted = false;
    this.upgrade = null;
    this.url = '';
    this.method = null;
    this.statusCode = null;
    this.statusMessage = null;
    this.client = socket;
    this._consuming = false;
    this._dumped = false;
  }
  Object.setPrototypeOf(IncomingMessage.prototype, Readable.prototype);
  Object.setPrototypeOf(IncomingMessage, Readable);
  Object.defineProperties(IncomingMessage.prototype, {
    connection: {
      configurable: true,
      enumerable: true,
      get() {
        return this.socket;
      },
      set(value) {
        this.socket = value;
      },
    },
    headers: {
      configurable: true,
      enumerable: true,
      get() {
        return (this[kHeaders] ??= trailerObj(this.rawHeaders));
      },
      set(value) {
        this[kHeaders] = value;
      },
    },
    headersDistinct: {
      configurable: true,
      enumerable: true,
      get() {
        return (this[kHeadersDistinct] ??= distinctObj(this.rawHeaders));
      },
      set(value) {
        this[kHeadersDistinct] = value;
      },
    },
    trailers: {
      configurable: true,
      enumerable: true,
      get() {
        return (this[kTrailers] ??= trailerObj(this.rawTrailers));
      },
      set(value) {
        this[kTrailers] = value;
      },
    },
    trailersDistinct: {
      configurable: true,
      enumerable: true,
      get() {
        return (this[kTrailersDistinct] ??= distinctObj(this.rawTrailers));
      },
      set(value) {
        this[kTrailersDistinct] = value;
      },
    },
  });
  IncomingMessage.prototype.setTimeout = function setTimeout(msecs, callback) {
    if (typeof callback === 'function') this.on('timeout', callback);
    return this;
  };
  IncomingMessage.prototype._read = function _read(n) {
    this._consuming = true;
    const read = this[kIncomingRead];
    if (read) return read.call(this, n);
  };
  IncomingMessage.prototype._destroy = function _destroy(err, callback) {
    const destroy = this[kIncomingDestroy];
    if (destroy) destroy.call(this, err, callback);
    else callback(err);
  };
  IncomingMessage.prototype._dump = function _dump() {
    if (!this._dumped) {
      this._dumped = true;
      this.removeAllListeners('data');
      this.resume();
    }
  };

  function makeIncomingMessage(socket, body) {
    const msg = new IncomingMessage(socket);
    msg.httpVersion = '1.1';
    msg.httpVersionMajor = 1;
    msg.httpVersionMinor = 1;
    msg.complete = true;
    if (body && body.length) msg.push(body);
    msg.push(null);
    handles?.notify?.();
    return msg;
  }

  function headersSentError(what) {
    return nodeError(Error, 'ERR_HTTP_HEADERS_SENT', `Cannot ${what} headers after they are sent to the client`);
  }

  function toBuffer(chunk, encoding) {
    return typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : Buffer.from(chunk);
  }

  function checkedChunk(msg, chunk, encoding, callback) {
    if (chunk === null) throw nodeError(TypeError, 'ERR_STREAM_NULL_VALUES', 'May not write null values to stream');
    if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
      throw ERR_INVALID_ARG_TYPE('chunk', ['string', 'Buffer', 'Uint8Array'], chunk);
    }
    const cb = typeof callback === 'function' ? callback : nop;
    if (msg.finished) {
      const err = nodeError(Error, 'ERR_STREAM_WRITE_AFTER_END', 'write after end');
      process.nextTick(() => {
        cb(err);
        if (!msg.destroyed) msg.emit('error', err);
      });
      return null;
    }
    if (msg.destroyed) {
      process.nextTick(cb, nodeError(Error, 'ERR_STREAM_DESTROYED', 'Cannot call write after a stream was destroyed'));
      return null;
    }
    return toBuffer(chunk, encoding);
  }

  function socketWrite(msg, socket, data, callback) {
    const ok = socket.write(data, callback);
    if (!ok) {
      msg[kNeedDrain] = true;
      if (!msg[kDrainWait]) {
        msg[kDrainWait] = true;
        socket.once('drain', () => {
          msg[kDrainWait] = false;
          if (!msg[kNeedDrain]) return;
          msg[kNeedDrain] = false;
          msg.emit('drain');
        });
      }
    }
    return ok;
  }

  function wire(data, encoding) {
    if (typeof data === 'string') return Buffer.from(data, encoding || 'utf8');
    return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  function byteLength(chunk, encoding) {
    return typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding || 'utf8') : chunk.byteLength;
  }

  function onError(msg, err, callback) {
    if (msg.destroyed) return;
    process.nextTick(() => {
      callback(err);
      if (!msg.destroyed) msg.emit('error', err);
    });
  }

  function strictContentLength(msg) {
    return (
      msg.strictContentLength &&
      msg._contentLength != null &&
      msg._hasBody &&
      !msg._removedContLen &&
      !msg.chunkedEncoding &&
      !msg.hasHeader('transfer-encoding')
    );
  }

  function contentLengthMismatch(actual, expected) {
    return nodeError(
      Error,
      'ERR_HTTP_CONTENT_LENGTH_MISMATCH',
      `Response body's content-length of ${actual} byte(s) does not match the content-length of ${expected} byte(s) set in header`
    );
  }

  function writeChunk(msg, chunk, encoding, callback, fromEnd) {
    if (typeof callback !== 'function') callback = nop;
    if (chunk === null) throw nodeError(TypeError, 'ERR_STREAM_NULL_VALUES', 'May not write null values to stream');
    if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
      throw ERR_INVALID_ARG_TYPE('chunk', ['string', 'Buffer', 'Uint8Array'], chunk);
    }
    let err;
    if (msg.finished) err = nodeError(Error, 'ERR_STREAM_WRITE_AFTER_END', 'write after end');
    else if (msg.destroyed) err = nodeError(Error, 'ERR_STREAM_DESTROYED', 'Cannot call write after a stream was destroyed');
    if (err) {
      if (!msg.destroyed) onError(msg, err, callback);
      else process.nextTick(callback, err);
      return false;
    }
    let len;
    if (msg.strictContentLength) {
      len = byteLength(chunk, encoding);
      const total = msg[kBytesWritten] + len;
      if (strictContentLength(msg) && (fromEnd ? total !== msg._contentLength : total > msg._contentLength)) {
        throw contentLengthMismatch(total, msg._contentLength);
      }
      msg[kBytesWritten] = total;
    }
    if (!msg._header) {
      if (fromEnd) msg._contentLength = len ??= byteLength(chunk, encoding);
      msg._implicitHeader();
    }
    if (!msg._hasBody) {
      process.nextTick(callback);
      return true;
    }
    if (msg.chunkedEncoding && chunk.length !== 0) {
      len ??= byteLength(chunk, encoding);
      if (msg[kCorked] && msg._headerSent) {
        msg[kChunkedBuffer].push(chunk, encoding, callback);
        msg[kChunkedLength] += len;
        return msg[kChunkedLength] < msg[kHighWaterMark];
      }
      return msg._send(Buffer.concat([Buffer.from(`${len.toString(16)}\r\n`, 'latin1'), wire(chunk, encoding), CRLF]), null, callback);
    }
    return msg._send(chunk, encoding, callback);
  }

  function matchHeader(self, state, field, value) {
    if (field.length < 4 || field.length > 17) return;
    field = field.toLowerCase();
    switch (field) {
      case 'connection':
        state.connection = true;
        self._removedConnection = false;
        if (RE_CONN_CLOSE.test(value)) self._last = true;
        else self.shouldKeepAlive = true;
        break;
      case 'transfer-encoding':
        state.te = true;
        self._removedTE = false;
        if (RE_TE_CHUNKED.test(value)) self.chunkedEncoding = true;
        break;
      case 'content-length':
        state.contLen = true;
        self._contentLength = +value;
        self._removedContLen = false;
        break;
      case 'date':
      case 'expect':
      case 'trailer':
        state[field] = true;
        break;
      case 'keep-alive':
        self._defaultKeepAlive = false;
        break;
    }
  }

  function storeHeader(self, state, key, value, validate) {
    if (validate) validateHeaderValue(key, value);
    state.header += `${key}: ${value}\r\n`;
    matchHeader(self, state, key, value);
  }

  function processHeader(self, state, key, value, validate) {
    if (validate) validateHeaderName(key);
    if (self._contentLength && key.length === 19 && key.toLowerCase() === 'content-disposition') {
      if (Array.isArray(value)) for (let i = 0; i < value.length; i++) value[i] = Buffer.from(value[i], 'latin1');
      else value = Buffer.from(value, 'latin1');
    }
    if (Array.isArray(value)) {
      if (value.length < 2 || key.length !== 6 || key.toLowerCase() !== 'cookie') {
        for (const item of value) storeHeader(self, state, key, item, validate);
        return;
      }
      value = value.join('; ');
    }
    storeHeader(self, state, key, value, validate);
  }

  function headerLines(entries) {
    let out = '';
    for (const [name, value] of entries) {
      if (Array.isArray(value)) {
        if (value.length >= 2 && String(name).toLowerCase() === 'cookie') out += `${name}: ${value.join('; ')}\r\n`;
        else for (const item of value) out += `${name}: ${item}\r\n`;
      } else out += `${name}: ${value}\r\n`;
    }
    return out;
  }

  function OutgoingMessage(options) {
    Stream.call(this);
    this.outputData = [];
    this.outputSize = 0;
    this.writable = true;
    this.destroyed = false;
    this._last = false;
    this.chunkedEncoding = false;
    this.shouldKeepAlive = true;
    this.maxRequestsOnConnectionReached = false;
    this._defaultKeepAlive = true;
    this.useChunkedEncodingByDefault = true;
    this.sendDate = false;
    this._removedConnection = false;
    this._removedContLen = false;
    this._removedTE = false;
    this.strictContentLength = false;
    this._contentLength = null;
    this._hasBody = true;
    this._trailer = '';
    this.finished = false;
    this._headerSent = false;
    this._closed = false;
    this[kSocket] = null;
    this._header = null;
    this[kOutHeaders] = null;
    this._keepAliveTimeout = 0;
    this._onPendingData = nop;
    this[kErrored] = null;
    this[kWritableFinished] = false;
    this[kNeedDrain] = false;
    this[kCorked] = 0;
    this[kBytesWritten] = 0;
    this[kChunkedBuffer] = [];
    this[kChunkedLength] = 0;
    this[kBatch] = null;
    this[kHighWaterMark] = options?.highWaterMark ?? 16384;
  }
  Object.setPrototypeOf(OutgoingMessage.prototype, Stream.prototype);
  Object.setPrototypeOf(OutgoingMessage, Stream);
  const getter = (get) => ({ configurable: true, enumerable: true, get });
  Object.defineProperties(OutgoingMessage.prototype, {
    errored: getter(function () {
      return this[kErrored];
    }),
    closed: getter(function () {
      return this._closed;
    }),
    writableFinished: getter(function () {
      return this[kWritableFinished];
    }),
    writableObjectMode: getter(() => false),
    writableLength: getter(function () {
      return this.outputSize + this[kChunkedLength] + (this[kBatch]?.size ?? 0) + (this.socket ? this.socket.writableLength : 0);
    }),
    writableHighWaterMark: getter(function () {
      return this.socket ? this.socket.writableHighWaterMark : this[kHighWaterMark];
    }),
    writableCorked: getter(function () {
      return this[kCorked];
    }),
    writableEnded: getter(function () {
      return this.finished;
    }),
    writableNeedDrain: getter(function () {
      return !this.destroyed && !this.finished && this[kNeedDrain];
    }),
    headersSent: getter(function () {
      return !!this._header;
    }),
    connection: {
      configurable: true,
      enumerable: true,
      get() {
        return this[kSocket];
      },
      set(value) {
        this.socket = value;
      },
    },
    socket: {
      configurable: true,
      enumerable: true,
      get() {
        return this[kSocket];
      },
      set(value) {
        this[kSocket] = value;
      },
    },
  });
  Object.assign(OutgoingMessage.prototype, {
    cork() {
      this[kCorked]++;
      this.socket?.cork?.();
    },
    uncork() {
      if (this[kCorked]) this[kCorked]--;
      this.socket?.uncork?.();
      if (this[kCorked] || this[kChunkedBuffer].length === 0) return;
      const buf = this[kChunkedBuffer];
      const parts = [Buffer.from(`${this[kChunkedLength].toString(16)}\r\n`, 'latin1')];
      const callbacks = [];
      for (let n = 0; n < buf.length; n += 3) {
        parts.push(wire(buf[n], buf[n + 1]));
        callbacks.push(buf[n + 2]);
      }
      parts.push(CRLF);
      this[kChunkedBuffer] = [];
      this[kChunkedLength] = 0;
      this._send(Buffer.concat(parts), null, (err) => {
        for (const callback of callbacks) callback(err);
      });
    },
    setTimeout(msecs, callback) {
      if (typeof callback === 'function') this.on('timeout', callback);
      return this;
    },
    destroy(error) {
      if (this.destroyed) return this;
      this.destroyed = true;
      this[kErrored] = error;
      if (this.socket) this.socket.destroy(error);
      else this.once('socket', (socket) => socket.destroy(error));
      return this;
    },
    setHeader(name, value) {
      if (this._header) throw headersSentError('set');
      validateHeaderName(name);
      validateHeaderValue(name, value);
      (this[kOutHeaders] ??= Object.create(null))[name.toLowerCase()] = [name, value];
      return this;
    },
    appendHeader(name, value) {
      if (this._header) throw headersSentError('append');
      validateHeaderName(name);
      validateHeaderValue(name, value);
      const entry = this[kOutHeaders]?.[name.toLowerCase()];
      if (!entry) return this.setHeader(name, value);
      if (!Array.isArray(entry[1])) entry[1] = [entry[1]];
      if (Array.isArray(value)) entry[1].push(...value);
      else entry[1].push(value);
      return this;
    },
    setHeaders(headers) {
      if (this._header) throw headersSentError('set');
      if (!headers || Array.isArray(headers) || typeof headers.keys !== 'function' || typeof headers.get !== 'function') {
        throw ERR_INVALID_ARG_TYPE('headers', ['Headers', 'Map'], headers);
      }
      const cookies = [];
      for (const [key, value] of headers) {
        if (key === 'set-cookie') {
          if (Array.isArray(value)) cookies.push(...value);
          else cookies.push(value);
          continue;
        }
        this.setHeader(key, value);
      }
      if (cookies.length) this.setHeader('set-cookie', cookies);
      return this;
    },
    getHeader(name) {
      validateString(name, 'name');
      return this[kOutHeaders]?.[name.toLowerCase()]?.[1];
    },
    getHeaderNames() {
      return this[kOutHeaders] ? Object.keys(this[kOutHeaders]) : [];
    },
    getRawHeaderNames() {
      return this[kOutHeaders] ? Object.values(this[kOutHeaders]).map((entry) => entry[0]) : [];
    },
    getHeaders() {
      const out = Object.create(null);
      for (const key of this.getHeaderNames()) out[key] = this[kOutHeaders][key][1];
      return out;
    },
    hasHeader(name) {
      validateString(name, 'name');
      return !!this[kOutHeaders]?.[name.toLowerCase()];
    },
    removeHeader(name) {
      validateString(name, 'name');
      if (this._header) throw headersSentError('remove');
      const key = name.toLowerCase();
      if (key === 'connection') this._removedConnection = true;
      else if (key === 'content-length') this._removedContLen = true;
      else if (key === 'transfer-encoding') this._removedTE = true;
      else if (key === 'date') this.sendDate = false;
      if (this[kOutHeaders]) delete this[kOutHeaders][key];
    },
    addTrailers(headers) {
      this._trailer = '';
      const pairs = Array.isArray(headers) ? headers : Object.entries(headers ?? {});
      for (const pair of pairs) {
        const [field, value] = Array.isArray(pair) ? pair : [pair, headers[pair]];
        validateHeaderName(field, 'Trailer name');
        if (Array.isArray(value) && value.length > 1) {
          for (const item of value) {
            validateHeaderValue(field, item);
            this._trailer += `${field}: ${item}\r\n`;
          }
        } else {
          validateHeaderValue(field, value);
          this._trailer += `${field}: ${value}\r\n`;
        }
      }
    },
    _implicitHeader() {
      throw nodeError(Error, 'ERR_METHOD_NOT_IMPLEMENTED', 'The _implicitHeader() method is not implemented');
    },
    flushHeaders() {
      if (!this._header) this._implicitHeader();
    },
    pipe() {
      this.emit('error', nodeError(Error, 'ERR_STREAM_CANNOT_PIPE', 'Cannot pipe, not readable'));
    },
    _send(data, encoding, callback) {
      if (!this._headerSent && this._header !== null) {
        if (typeof data === 'string' && (encoding === 'utf8' || encoding === 'latin1' || !encoding)) {
          data = this._header + data;
        } else {
          data = Buffer.concat([Buffer.from(this._header, 'latin1'), wire(data, encoding)]);
          encoding = null;
        }
        this._headerSent = true;
      }
      return this._writeRaw(data, encoding, callback);
    },
    _writeRaw(data, encoding, callback) {
      const socket = this.socket;
      if (socket?.destroyed) return false;
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = null;
      }
      if (socket && socket._httpMessage === this && socket.writable) {
        if (this.outputData.length) this._flushOutput(socket);
        return this[kSocketWrite](socket, wire(data, encoding), callback);
      }
      this.outputData.push({ data, encoding, callback });
      this.outputSize += data.length;
      this._onPendingData(data.length);
      return this.outputSize < this[kHighWaterMark];
    },
    [kSocketWrite](socket, buf, callback) {
      const batch = this[kBatch];
      if (batch) {
        batch.socket = socket;
        batch.size = (batch.size ?? 0) + buf.length;
        batch.push(buf, callback);
        return true;
      }
      return socketWrite(this, socket, buf, callback ?? nop);
    },
    [kUncorkWire]() {
      const batch = this[kBatch];
      this[kBatch] = null;
      if (!batch?.length) return undefined;
      const bufs = [];
      const callbacks = [];
      for (let i = 0; i < batch.length; i += 2) {
        if (batch[i].length) bufs.push(batch[i]);
        if (batch[i + 1]) callbacks.push(batch[i + 1]);
      }
      const data = bufs.length === 1 ? bufs[0] : Buffer.concat(bufs);
      if (!data.length && !callbacks.length) return true;
      return socketWrite(this, batch.socket, data, (err) => {
        for (const callback of callbacks) callback(err);
      });
    },
    _flushOutput(socket) {
      const pending = this.outputData;
      if (!pending.length) return undefined;
      this.outputData = [];
      const own = !this[kBatch];
      if (own) this[kBatch] = [];
      let ret;
      for (const { data, encoding, callback } of pending) ret = this[kSocketWrite](socket, wire(data, encoding), callback);
      if (own) ret = this[kUncorkWire]();
      this._onPendingData(-this.outputSize);
      this.outputSize = 0;
      return ret;
    },
    _flush() {
      const socket = this.socket;
      if (!socket?.writable) return;
      const ret = this._flushOutput(socket);
      if (this.finished) this._finish();
      else if (ret && this[kNeedDrain]) {
        this[kNeedDrain] = false;
        this.emit('drain');
      }
    },
    _finish() {
      this.emit('prefinish');
    },
    _storeHeader(firstLine, headers) {
      const state = { connection: false, contLen: false, te: false, date: false, expect: false, trailer: false, header: firstLine };
      if (headers) {
        if (headers === this[kOutHeaders]) {
          for (const key in headers) processHeader(this, state, headers[key][0], headers[key][1], false);
        } else if (Array.isArray(headers)) {
          if (headers.length && Array.isArray(headers[0])) {
            for (const entry of headers) processHeader(this, state, entry[0], entry[1], true);
          } else {
            if (headers.length % 2 !== 0) throw ERR_INVALID_ARG_VALUE('headers', headers);
            for (let n = 0; n < headers.length; n += 2) processHeader(this, state, headers[n], headers[n + 1], true);
          }
        } else {
          for (const key in headers) if (Object.hasOwn(headers, key)) processHeader(this, state, key, headers[key], true);
        }
      }
      let { header } = state;
      if (this.sendDate && !state.date) header += `Date: ${new Date().toUTCString()}\r\n`;
      if (this.chunkedEncoding && (this.statusCode === 204 || this.statusCode === 304)) {
        this.chunkedEncoding = false;
        this.shouldKeepAlive = false;
      }
      if (this._removedConnection) {
        this._last = !this.shouldKeepAlive;
      } else if (!state.connection) {
        const shouldSendKeepAlive = this.shouldKeepAlive && (state.contLen || this.useChunkedEncodingByDefault || this.agent);
        if (shouldSendKeepAlive && this.maxRequestsOnConnectionReached) {
          header += 'Connection: close\r\n';
        } else if (shouldSendKeepAlive) {
          header += 'Connection: keep-alive\r\n';
          if (this._keepAliveTimeout && this._defaultKeepAlive) {
            const max = ~~this._maxRequestsPerSocket > 0 ? `, max=${this._maxRequestsPerSocket}` : '';
            header += `Keep-Alive: timeout=${Math.floor(this._keepAliveTimeout / 1000)}${max}\r\n`;
          }
        } else {
          this._last = true;
          header += 'Connection: close\r\n';
        }
      }
      if (!state.contLen && !state.te) {
        if (!this._hasBody) {
          this.chunkedEncoding = false;
        } else if (!this.useChunkedEncodingByDefault) {
          this._last = true;
        } else if (!state.trailer && !this._removedContLen && typeof this._contentLength === 'number') {
          header += `Content-Length: ${this._contentLength}\r\n`;
        } else if (!this._removedTE) {
          header += 'Transfer-Encoding: chunked\r\n';
          this.chunkedEncoding = true;
        } else {
          this._last = true;
        }
      }
      if (this.chunkedEncoding !== true && state.trailer) {
        throw nodeError(Error, 'ERR_HTTP_TRAILER_INVALID', 'Trailers are invalid with this transfer encoding');
      }
      this._header = `${header}\r\n`;
      this._headerSent = false;
      if (state.expect) this._send('');
    },
    write(chunk, encoding, callback) {
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      const buf = checkedChunk(this, chunk, encoding, callback);
      if (buf === null) return false;
      return this[kWriteBody](buf, typeof callback === 'function' ? callback : nop) !== false && !this[kNeedDrain];
    },
    end(chunk, encoding, callback) {
      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = null;
        encoding = null;
      } else if (typeof encoding === 'function') {
        callback = encoding;
        encoding = null;
      }
      let buf = null;
      if (chunk != null) {
        buf = checkedChunk(this, chunk, encoding, callback);
        if (buf === null) return this;
      } else if (this.finished) {
        if (typeof callback === 'function') {
          if (!this.writableFinished) this.on('finish', callback);
          else callback(nodeError(Error, 'ERR_STREAM_ALREADY_FINISHED', 'Cannot call end after a stream was finished'));
        }
        return this;
      }
      if (typeof callback === 'function') this.once('finish', callback);
      this.finished = true;
      if (!this.destroyed) this[kEndBody](buf);
      return this;
    },
    [kWriteBody](buf, callback) {
      if (!this._header) this._implicitHeader();
      return this._writeRaw(buf, callback);
    },
    [kEndBody](buf) {
      if (!this._header) this._implicitHeader();
      this._writeRaw(buf ?? Buffer.alloc(0), () => this[kFinish]());
    },
    [kFinish]() {
      this[kWritableFinished] = true;
      this.emit('finish');
    },
  });

  function ServerResponse(req, options) {
    OutgoingMessage.call(this, options);
    if (req?.method === 'HEAD') this._hasBody = false;
    this.req = req;
    this.sendDate = true;
    this._sent100 = false;
    this._expect_continue = false;
    if (req && (req.httpVersionMajor < 1 || req.httpVersionMinor < 1)) {
      this.useChunkedEncodingByDefault = RE_TE_CHUNKED.test(req.headers?.te);
      this.shouldKeepAlive = false;
    }
  }
  Object.setPrototypeOf(ServerResponse.prototype, OutgoingMessage.prototype);
  Object.setPrototypeOf(ServerResponse, OutgoingMessage);
  ServerResponse.prototype.statusCode = 200;
  ServerResponse.prototype.statusMessage = undefined;
  Object.assign(ServerResponse.prototype, {
    assignSocket(socket) {
      socket._httpMessage = this;
      this.socket = socket;
      this.emit('socket', socket);
      this._flush();
    },
    detachSocket(socket) {
      if (socket._httpMessage === this) socket._httpMessage = null;
      this.socket = null;
    },
    _implicitHeader() {
      this.writeHead(this.statusCode);
    },
    writeHead(statusCode, reason, obj) {
      if (this._header) throw headersSentError('write');
      const originalStatusCode = statusCode;
      statusCode |= 0;
      if (statusCode < 100 || statusCode > 999) {
        throw nodeError(RangeError, 'ERR_HTTP_INVALID_STATUS_CODE', `Invalid status code: ${originalStatusCode}`);
      }
      if (typeof reason === 'string') {
        this.statusMessage = reason;
      } else {
        this.statusMessage ||= STATUS_CODES[statusCode] || 'unknown';
        obj ??= reason;
      }
      this.statusCode = statusCode;
      let headers;
      if (this[kOutHeaders]) {
        if (Array.isArray(obj)) {
          if (obj.length % 2 !== 0) throw ERR_INVALID_ARG_VALUE('headers', obj);
          for (let n = 0; n < obj.length; n += 2) this.removeHeader(obj[n]);
          for (let n = 0; n < obj.length; n += 2) if (obj[n]) this.appendHeader(obj[n], obj[n + 1]);
        } else if (obj) {
          for (const k of Object.keys(obj)) if (k) this.setHeader(k, obj[k]);
        }
        headers = this[kOutHeaders];
      } else {
        headers = obj;
      }
      if (headerCharRegex.test(this.statusMessage)) throw nodeError(TypeError, 'ERR_INVALID_CHAR', 'Invalid character in statusMessage');
      const statusLine = `HTTP/1.1 ${statusCode} ${this.statusMessage}\r\n`;
      if (statusCode === 204 || statusCode === 304 || (statusCode >= 100 && statusCode <= 199)) this._hasBody = false;
      if (this._expect_continue && !this._sent100) this.shouldKeepAlive = false;
      this._storeHeader(statusLine, headers);
      return this;
    },
    flushHeaders() {
      if (!this._header) this._implicitHeader();
      this._send('');
    },
    writeContinue(callback) {
      this._writeRaw('HTTP/1.1 100 Continue\r\n\r\n', 'ascii', callback);
      this._sent100 = true;
    },
    write(chunk, encoding, callback) {
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = null;
      }
      const ret = writeChunk(this, chunk, encoding, callback, false);
      if (!ret) this[kNeedDrain] = true;
      return ret;
    },
    end(chunk, encoding, callback) {
      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = null;
        encoding = null;
      } else if (typeof encoding === 'function') {
        callback = encoding;
        encoding = null;
      }
      if (chunk) {
        if (this.finished) {
          onError(this, nodeError(Error, 'ERR_STREAM_WRITE_AFTER_END', 'write after end'), typeof callback !== 'function' ? nop : callback);
          return this;
        }
      } else if (this.finished) {
        if (typeof callback === 'function') {
          if (!this.writableFinished) this.on('finish', callback);
          else callback(nodeError(Error, 'ERR_STREAM_ALREADY_FINISHED', 'Cannot call end after a stream was finished'));
        }
        return this;
      }
      if (chunk) {
        this[kBatch] ??= [];
        writeChunk(this, chunk, encoding, null, true);
      } else if (!this._header) {
        this[kBatch] ??= [];
        this._contentLength = 0;
        this._implicitHeader();
      }
      if (typeof callback === 'function') this.once('finish', callback);
      if (strictContentLength(this) && this[kBytesWritten] !== this._contentLength) {
        throw contentLengthMismatch(this[kBytesWritten], this._contentLength);
      }
      this[kBatch] ??= [];
      if (this[kChunkedBuffer].length !== 0) {
        this.socket?.cork?.();
        this[kCorked] = 1;
        this.uncork();
      }
      const finish = () => {
        if (this.socket?._hadError) return;
        this[kFinish]();
      };
      if (this._hasBody && this.chunkedEncoding) this._send(`0\r\n${this._trailer}\r\n`, 'latin1', finish);
      else if (!this._headerSent || this.writableLength || chunk) this._send('', 'latin1', finish);
      else process.nextTick(finish);
      this[kUncorkWire]();
      const state = this.socket?._writableState;
      if (state?.corked) {
        state.corked = 1;
        this.socket.uncork();
      }
      this[kCorked] = 1;
      this.uncork();
      this.finished = true;
      if (this.outputData.length === 0 && this.socket && this.socket._httpMessage === this) this._finish();
      return this;
    },
    destroy(error) {
      if (this.destroyed) return this;
      OutgoingMessage.prototype.destroy.call(this, error);
      process.nextTick(() => this[kEmitClose]());
      return this;
    },
    [kEmitClose]() {
      if (this._closed) return;
      this.destroyed = true;
      this._closed = true;
      this.emit('close');
    },
  });
  ServerResponse.prototype.writeHeader = ServerResponse.prototype.writeHead;

  function closeGracefully(socket) {
    const done = () => {
      clearTimeout(timer);
      socket.destroy();
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
    const resource = resourceHere();
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
    const pump = () => runInResource(resource, pumpNow, null, []);
    const pumpNow = () => {
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
      if (parsed.error) {
        socket.off('data', onData);
        if (server.listenerCount('clientError') > 0) {
          server.emit('clientError', parsed.error, socket);
          return;
        }
        try {
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n', destroy);
        } catch {
          destroy();
        }
        return;
      }
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
      if (parsed.httpVersion === '1.1' && parsed.method !== 'CONNECT' && server.requireHostHeader && headers.host === undefined) {
        clearTimeout(requestTimer);
        requestTimer = null;
        socket.off('data', onData);
        busy = true;
        buf = Buffer.alloc(0);
        const req = makeIncomingMessage(socket, Buffer.alloc(0));
        setRequestLine(req, parsed, headers);
        const res = new ServerResponse(req);
        res.assignSocket(socket);
        res.on('finish', () => {
          res.detachSocket(socket);
          destroy();
        });
        res.writeHead(400, ['Connection', 'close']);
        res.end();
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
      const emit = req.emit;
      req.emit = function (...args) {
        return runInResource(resource, emit, this, args);
      };
      setRequestLine(req, parsed, headers);
      const res = new ServerResponse(req);
      res.assignSocket(socket);
      // Node's shouldKeepAlive: HTTP/1.1 unless the client says close, and
      // below maxRequestsPerSocket. A connection that is open when close()
      // is called keeps serving as before (Node 22): it closes when idle.
      const max = server.maxRequestsPerSocket;
      const tokens = connectionTokens.split(',').map((token) => token.trim());
      const persistent = req.httpVersionMajor > 0 && req.httpVersionMinor > 0 ? !tokens.includes('close') : tokens.includes('keep-alive');
      res.shouldKeepAlive = persistent && !(max > 0 && served >= max);
      res._keepAliveTimeout = server.keepAliveTimeout;
      res._maxRequestsPerSocket = max;
      // The client gone before the response ended (an aborted SSE or
      // long-poll): Node's 'close' on both, so the handler can stop.
      const gone = () => {
        if (!res.writableFinished && !res.destroyed) {
          res.destroyed = true;
          process.nextTick(() => res[kEmitClose]());
        }
        if (!req.destroyed) req.destroy();
      };
      // Node (httpAllowHalfOpen false): the client's FIN aborts a response
      // still going, and the server ends its side.
      const onEnd = () => {
        if (res.writableFinished) return;
        gone();
        try {
          socket.end();
        } catch {
          /* ignore */
        }
      };
      socket.once('close', gone);
      socket.once('end', onEnd);
      const keptAlive = () => {
        socket.off('close', gone);
        socket.off('end', onEnd);
        busy = false;
        conn.idle = true;
        // The request's 'close' (Node emits it once the response is done).
        if (!req.destroyed) req.destroy();
        armIdle();
        queueMicrotask(pump);
      };
      res.on('finish', () => {
        res.detachSocket(socket);
        process.nextTick(() => res[kEmitClose]());
        if (socket.destroyed) return;
        if (!res._last) keptAlive();
        else if (server._closing) closeGracefully(socket);
        else {
          socket.unref?.();
          destroy();
        }
      });
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

  function Server(options, requestListener) {
    if (!new.target) return new Server(options, requestListener);
    if (typeof options === 'function') {
      requestListener = options;
      options = {};
    }
    // Peer may FIN after the request while we still write the response.
    const self = Reflect.construct(net.Server, [{ ...options, allowHalfOpen: true }], new.target);
    // Node: http.Server sockets default allowHalfOpen true (readable property).
    self.allowHalfOpen = true;
    storeHttpOptions(self, options);
    self[kRequestListener] = requestListener;
    self.on('connection', (socket) => {
      handleConnection(socket, self[kRequestListener], self);
    });
    self.on('listening', () => {
      self._closing = false;
    });
    return self;
  }

  function storeHttpOptions(self, options) {
    // Node 22's defaults.
    self.keepAliveTimeout = 5000;
    self.keepAliveTimeoutBuffer = 1000;
    self.headersTimeout = 60000;
    self.requestTimeout = 300000;
    self.maxRequestsPerSocket = 0;
    self.maxHeadersCount = null;
    self.timeout = 0;
    if (options?.requireHostHeader !== undefined) validateBoolean(options.requireHostHeader, 'options.requireHostHeader');
    self.requireHostHeader = options?.requireHostHeader ?? true;
    /** @internal This server's connections, and whether each is between requests. */
    self._connections = new Set();
    self._closing = false;
    self._connectionGone = null;
    // Node's options for them (lib/_http_server.js storeHTTPOptions):
    // integers >= 0, and headersTimeout no longer than requestTimeout.
    for (const key of ['requestTimeout', 'headersTimeout', 'keepAliveTimeout', 'keepAliveTimeoutBuffer']) {
      const value = options?.[key];
      if (value === undefined) continue;
      validateInteger(value, key, 0);
      self[key] = value;
    }
    // Node: headersTimeout defaults to min(60 s, requestTimeout).
    if (options?.headersTimeout === undefined) self.headersTimeout = Math.min(60000, self.requestTimeout);
    if (self.requestTimeout > 0 && self.headersTimeout > 0 && self.headersTimeout > self.requestTimeout) {
      throw ERR_OUT_OF_RANGE('headersTimeout', '<= requestTimeout', self.headersTimeout);
    }
  }
  Object.setPrototypeOf(Server.prototype, net.Server.prototype);
  Object.setPrototypeOf(Server, net.Server);
  Object.assign(Server.prototype, {
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
    },
    closeAllConnections() {
      for (const conn of [...this._connections]) {
        this._connections.delete(conn);
        try {
          conn.socket.destroy();
        } catch {
          /* ignore */
        }
      }
    },
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
      const r = net.Server.prototype.close.call(this, (err) => {
        listenerClosed = true;
        done(err);
      });
      this.closeIdleConnections();
      return r;
    },
    setTimeout(ms, callback) {
      this.timeout = Number(ms) || 0;
      if (typeof callback === 'function') this.on('timeout', callback);
      return this;
    },
  });

  function createServer(options, requestListener) {
    return new Server(options, requestListener);
  }

  /** Node's _http_agent.js calculateServerName. */
  function calculateServerName(options, req) {
    let servername = options.host;
    const hostHeader = req?.getHeader?.('host');
    if (hostHeader) {
      if (hostHeader[0] === '[') {
        const index = hostHeader.indexOf(']');
        servername = index === -1 ? hostHeader : hostHeader.substring(1, index);
      } else servername = String(hostHeader).split(':', 1)[0];
    }
    if (net.isIP(servername)) servername = '';
    return servername;
  }

  function Agent(options) {
    if (!(this instanceof Agent)) return new Agent(options);
    EventEmitter.call(this);
    options ??= {};
    this.defaultPort = 80;
    this.options = options;
    this.keepAlive = Boolean(options.keepAlive);
    this.maxSockets = options.maxSockets ?? Infinity;
    this.maxFreeSockets = options.maxFreeSockets ?? 256;
    this.maxTotalSockets = options.maxTotalSockets ?? Infinity;
    this.totalSocketCount = 0;
    this.protocol = options.protocol ?? 'http:';
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
    this.on('free', (socket, options) => this[kOnFree](socket, options));
  }
  Object.setPrototypeOf(Agent.prototype, EventEmitter.prototype);
  Object.setPrototypeOf(Agent, EventEmitter);
  Object.assign(Agent.prototype, {
    [kOnFree](socket, options = {}) {
      const name = this.getName(options);
      const queue = this.requests[name];
      if (!socket.destroyed && queue?.length) {
        const req = queue.shift();
        if (!queue.length) delete this.requests[name];
        this[kHandoff](req, socket);
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
    },
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
        }
      }
    },
    getName(options = {}) {
      // Node: `${host}:${port}:${localAddress}` (trailing colon when no localAddress).
      let name = options.host || options.hostname || 'localhost';
      name += ':';
      if (options.port) name += options.port;
      name += ':';
      if (options.localAddress) name += options.localAddress;
      if (options.family === 4 || options.family === 6) name += `:${options.family}`;
      return name;
    },
    createConnection(options, callback) {
      // TCP only: never treat HTTP URL `path` as a UNIX socket path.
      const opts = { ...options };
      if (!opts.socketPath && typeof opts.path === 'string' && opts.path.startsWith('/')) {
        delete opts.path;
      }
      return net.createConnection(opts, callback);
    },
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
    },
    reuseSocket(socket, req) {
      req.reusedSocket = true;
      socket.ref?.();
    },
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
      if (!options.servername && options.servername !== '') options.servername = calculateServerName(options, req);

      const name = this.getName(options);
      this.sockets[name] ||= [];

      const free = this.freeSockets[name];
      if (free?.length) {
        const socket = this.scheduling === 'fifo' ? free.shift() : free.pop();
        if (!free.length) delete this.freeSockets[name];
        if (socket && !socket.destroyed) {
          this.reuseSocket(socket, req);
          this.sockets[name].push(socket);
          this[kHandoff](req, socket);
          return;
        }
      }

      const sockLen = this.sockets[name].length;
      if (sockLen < this.maxSockets && this.totalSocketCount < this.maxTotalSockets) {
        this.createSocket(req, options, (err, socket) => {
          if (err) {
            this[kHandoff](req, null, err);
            return;
          }
          this[kHandoff](req, socket);
        });
        return;
      }

      this.requests[name] ||= [];
      this.requests[name].push(req);
    },
    createSocket(req, options, cb) {
      options = { ...options, ...this.options };
      if (options.socketPath) options.path = options.socketPath;
      // Node's normalizeServerName: the SNI from the Host header (or host),
      // never an IP address.
      if (!options.servername && options.servername !== '') options.servername = calculateServerName(options, req);
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
    },
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
          if (err) this[kHandoff](req, null, err);
          else this[kHandoff](req, s);
        });
      }
    },
    [kHandoff](req, socket, err) {
      if (typeof req.onSocket === 'function') {
        req.onSocket(socket, err);
        return;
      }
      if (err) {
        emitError(req, err);
        return;
      }
      req.emit?.('socket', socket);
    },
  });
  Agent.defaultMaxSockets = Infinity;

  // Node 22's: keep-alive, LIFO, free sockets closed after 5 s.
  const globalAgent = new Agent({ keepAlive: true, scheduling: 'lifo', timeout: 5000 });

  function ClientRequest(input, options, cb) {
    OutgoingMessage.call(this);
    ({ options, callback: cb } = normalizeRequestArgs(input, options, cb));
    this[kOpts] = options;
    this[kChunks] = [];
    this[kConnSocket] = null;
    this[kConnected] = false;
    this[kEnded] = false;
    this[kStreaming] = false;
    this[kResource] = resourceHere();
    this[kAbortBody] = null;
    this[kFetchMode] = false;
    this[kFetchSent] = false;
    this[kFetchAbort] = null;
    this[kNoRouteError] = null;
    this[kFetchVia] = options[kFetchVia] ?? null;
    this[kFetchTimer] = null;
    if (this[kFetchVia]) this[kFetchMode] = true;
    this.reusedSocket = false;
    // Node's: what the request is, readable as res.req's.
    this.method = String(options.method ?? 'GET').toUpperCase();
    this.path = options.path ?? '/';
    this.host = options.hostname ?? options.host ?? 'localhost';
    this.protocol = options.protocol ?? 'http:';
    for (const [k, v] of Object.entries(options.headers ?? {})) this.setHeader(k, v);
    // Node: keep-alive when the agent keeps sockets (the global agent does).
    // With its own createConnection and no agent, a request has no agent
    // (Node's ClientRequest); https hands in its own default agent.
    const defaultAgent = options._defaultAgent ?? globalAgent;
    const agent =
      options.agent === false
        ? null
        : (options.agent ?? (typeof options.createConnection === 'function' ? null : defaultAgent));
    this.agent = agent ?? undefined;
    this.shouldKeepAlive = Boolean(agent?.keepAlive);
    // Node's: Host is set here, after the given headers, so an agent's
    // addRequest sees it (http-proxy-agent builds the absolute URL from it).
    if (!this.hasHeader('host') && options.setHost !== false) {
      let hostHeader = String(options.hostname ?? options.host ?? 'localhost');
      const colon = hostHeader.indexOf(':');
      if (colon !== -1 && hostHeader.includes(':', colon + 1) && hostHeader[0] !== '[') hostHeader = `[${hostHeader}]`;
      const defaultPort = options.defaultPort || agent?.defaultPort || 80;
      if (options.port && +options.port !== defaultPort) hostHeader += `:${options.port}`;
      setRawHeader(this, 'Host', hostHeader);
    }
    if (cb) this.once('response', cb);
    queueMicrotask(() => this[kConnect]());
  }
  Object.setPrototypeOf(ClientRequest.prototype, OutgoingMessage.prototype);
  Object.setPrototypeOf(ClientRequest, OutgoingMessage);
  Object.assign(ClientRequest.prototype, {
    setTimeout(msecs, callback) {
      if (typeof callback === 'function') this.on('timeout', callback);
      if (this[kFetchVia]) {
        clearTimeout(this[kFetchTimer]);
        this[kFetchTimer] = null;
        if (msecs > 0) {
          this[kFetchTimer] = setTimeout(() => {
            this[kFetchTimer] = null;
            this.emit('timeout');
          }, msecs);
          this[kFetchTimer].unref?.();
        }
      }
      return this;
    },
    abort() {
      this.destroy();
    },
    clearTimeout(callback) {
      return this.setTimeout(0, callback);
    },
    setNoDelay(noDelay) {
      this._deferToConnect('setNoDelay', [noDelay]);
    },
    setSocketKeepAlive(enable, initialDelay) {
      this._deferToConnect('setKeepAlive', [enable, initialDelay]);
    },
    _deferToConnect(method, args) {
      const call = (socket) => socket[method]?.(...args);
      if (this.socket) call(this.socket);
      else this.once('socket', call);
    },

    /** Node ClientRequest.onSocket — Agent delivers the socket here. */
    onSocket(socket, err) {
      if (err) {
        emitError(this, err);
        return;
      }
      this[kAttachSocket](socket);
    },

    [kConnect]() {
      if (this[kFetchVia]) return;
      const opts = this[kOpts];
      const host = opts.hostname ?? opts.host ?? '127.0.0.1';
      const port = Number(opts.port ?? (opts.protocol === 'https:' ? 443 : 80));
      // Node's: the request's own options go to the agent (an https agent's
      // tls.connect takes ca, servername, rejectUnauthorized … from them).
      const { signal: _ignored, ...given } = opts;
      void _ignored;
      // The method only as given, as in Node.
      const options = {
        ...given,
        host,
        hostname: host,
        port,
        path: opts.path ?? '/',
        protocol: opts.protocol,
      };
      if (opts.socketPath) options.socketPath = opts.socketPath;
      if (opts.localAddress) options.localAddress = opts.localAddress;
      if (opts.family) options.family = opts.family;

      const agent = this.agent;
      if (!agent) {
        // Node's: the request's own createConnection(options, oncreate), which
        // may return the socket or hand it to oncreate (ws's tlsConnect).
        if (typeof opts.createConnection === 'function') {
          let done = false;
          const oncreate = (err, socket) => {
            if (done) return;
            done = true;
            if (err) {
              emitError(this, err);
              if (!this.destroyed) this.destroy();
              return;
            }
            this[kAttachSocket](socket);
          };
          const { signal: _signal, ...withoutSignal } = { ...opts, ...options };
          void _signal;
          const socket = opts.createConnection(withoutSignal, oncreate);
          if (socket) oncreate(null, socket);
          return;
        }
        const connectOpts = { host, port };
        if (options.socketPath) connectOpts.path = options.socketPath;
        this[kAttachSocket](net.connect(connectOpts));
        return;
      }
      // Node / agent-base: must enter through addRequest → createSocket → createConnection.
      agent.addRequest(this, options);
    },

    [kAttachSocket](socket) {
      this[kConnSocket] = socket;
      this.socket = socket;
      socket._httpMessage = this;
      const method = (this[kOpts].method ?? 'GET').toUpperCase();
      let headBuf = Buffer.alloc(0);
      let socketEnded = false;
      let emitted = false;

      // Only our own listeners come off at the end: an Agent's 'close'
      // listener (removeSocket, which hands the socket's slot to the next
      // queued request) must still hear the socket close.
      const own = [];
      const resource = this[kResource];
      const listen = (event, fn) => {
        const inFrame = (...args) => runInResource(resource, fn, socket, args);
        socket.on(event, inFrame);
        own.push([event, inFrame]);
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
        if (this[kViaFetchOnNoRoute](err)) return;
        emitted = true;
        if (!this.listenerCount('error')) socket.destroy();
        emitError(this, resetOfReused(this, err));
        // Node: 'error', then the request's 'close'.
        if (!this.destroyed) this.destroy();
      });
      const onReady = () => {
        this[kConnected] = true;
        this.emit('socket', socket);
        // With Content-Length: send headers + any buffered body and stream the rest.
        // Without: wait for end() and send one framed request (buffer until end).
        if (rawHeader(this, 'content-length') != null || this[kEnded]) {
          this[kFlushHead]();
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
        this[kConnSocket] = null;
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
      this[kAbortBody] = abortBody;
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
              // Node's: the trailers are the response's before its 'end'.
              res.rawTrailers = f.rawTrailers ?? [];
              res.trailers = trailerObj(res.rawTrailers);
              finish();
              return;
            }
            const text = Buffer.from(line).toString('latin1');
            const colon = text.indexOf(':');
            if (colon > 0) (f.rawTrailers ??= []).push(text.slice(0, colon).trim(), text.slice(colon + 1).trim());
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
        if (parsed.error) {
          emitted = true;
          quietClose();
          emitError(this, parsed.error);
          if (!this.destroyed) this.destroy();
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
          this[kConnSocket] = null;
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
        res = new IncomingMessage(socket);
        res[kIncomingRead] = () => socket.resume?.();
        // Destroying the response closes the connection (Node's).
        res[kIncomingDestroy] = (err, callback) => {
          if (!finished) {
            finished = true;
            quietClose();
          }
          callback(err);
        };
        res.httpVersion = parsed.httpVersion;
        res.httpVersionMajor = 1;
        res.httpVersionMinor = 1;
        res.statusCode = parsed.statusCode;
        res.statusMessage = parsed.statusMessage;
        res.rawHeaders = parsed.rawHeaders;
        res.headers = headers;
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
        if (!res && !this.destroyed && this[kConnected] && !this[kFetchMode]) {
          emitted = true;
          const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
          emitError(this, err);
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
    },

    /**
     * The kernel has no route to the host (no uplink, or an address outside
     * its route table: ENOENT / ENETUNREACH from the connect, before a byte
     * went out): send the request through ctx.fetch instead, as https does.
     * Loopback stays the kernel's own; a request with its own agent (a
     * proxy's), a socketPath or no ctx.fetch gets the error.
     */
    [kViaFetchOnNoRoute](err) {
      const code = err?.cause?.code ?? err?.code;
      if (this[kFetchMode] || this._headerSent || this[kConnected]) return false;
      // An https request on a socket never falls back: fetch here is plain http.
      if (this.protocol === 'https:') return false;
      if (code !== 'ENOENT' && code !== 'ENETUNREACH' && code !== 'ENOTFOUND') return false;
      const opts = this[kOpts];
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
      this[kFetchMode] = true;
      this[kNoRouteError] = err;
      try {
        this[kConnSocket]?.destroy?.();
      } catch {
        /* ignore */
      }
      this[kConnSocket] = null;
      this.socket = null;
      if (this[kEnded]) this[kSendViaFetch]();
      return true;
    },

    [kSendViaFetch]() {
      if (this[kFetchSent]) return;
      this[kFetchSent] = true;
      const opts = this[kOpts];
      const host = opts.hostname ?? opts.host;
      const port = Number(opts.port ?? (this[kFetchVia] ? 443 : 80));
      const method = (opts.method ?? 'GET').toUpperCase();
      const body = Buffer.concat(this[kChunks]);
      this[kChunks] = [];
      const headers = this.getHeaders();
      this._headerSent = true;
      this._header ||= this[kRenderHead]().toString('latin1');
      this[kFetchAbort] = new AbortController();
      const send = this[kFetchVia]?.send ?? ((request) => getFetchClient().send({ protocol: 'http:', ...request }));
      const pending = send({ host, port, path: opts.path ?? '/', method, headers, body, signal: this[kFetchAbort].signal, req: this })
        .then(
          (res) => {
            if (this.destroyed) {
              res.destroy();
              return;
            }
            this.res = res;
            res.once('close', () => {
              if (!this.destroyed) this.destroy();
            });
            this.emit('response', res);
          },
          (err) => {
            if (this.destroyed) return;
            // No network for fetch either: the connect's own error, as Node gives it.
            const code = err?.cause?.cause?.code ?? err?.cause?.code;
            const e = code === 'ENETUNREACH' && this[kNoRouteError] ? this[kNoRouteError] : err;
            emitError(this, e);
            if (!this.destroyed) this.destroy();
          }
        );
      if (handles) void trackPromise(handles, pending);
    },

    destroy(err) {
      if (this.destroyed) return this;
      this.destroyed = true;
      if (err) this[kErrored] = err;
      // req.destroy(): the connection goes, and a body still coming is cut short.
      if (this[kFetchTimer]) clearTimeout(this[kFetchTimer]);
      this[kFetchAbort]?.abort();
      this[kAbortBody]?.();
      try {
        this[kConnSocket]?.destroy?.();
      } catch {
        /* ignore */
      }
      process.nextTick(() => {
        if (err) this.emit('error', err);
        this._closed = true;
        this.emit('close');
      });
      return this;
    },

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
      this._header = this[kRenderHead]().toString('latin1');
    },

    [kRenderHead]() {
      const opts = this[kOpts];
      // Node's: the request line is the request's method and path as they are
      // now (an agent may have rewritten the path).
      const method = String(this.method ?? opts.method ?? 'GET').toUpperCase();
      const path = this.path ?? opts.path ?? '/';
      if (/\bclose\b/i.test(String(rawHeader(this, 'connection') ?? ''))) this.shouldKeepAlive = false;
      if (!this.hasHeader('connection')) setRawHeader(this, 'Connection', this.shouldKeepAlive ? 'keep-alive' : 'close');
      return Buffer.from(`${method} ${path} HTTP/1.1\r\n${headerLines(Object.values(this[kOutHeaders]))}\r\n`);
    },

    [kFlushHead]() {
      if (this._headerSent || !this[kConnSocket]) return;
      this._headerSent = true;
      const body = Buffer.concat(this[kChunks]);
      this[kChunks] = [];
      if (rawHeader(this, 'content-length') != null) {
        this[kStreaming] = true;
      } else if (this[kEnded]) {
        // Node: a GET / HEAD / DELETE / OPTIONS / TRACE / CONNECT with no body
        // sends no Content-Length (the others send 0).
        const method = (this[kOpts].method ?? 'GET').toUpperCase();
        const bodiless = ['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'].includes(method);
        if (body.length > 0 || !bodiless) setRawHeader(this, 'Content-Length', String(body.length));
      }
      const head = this[kRenderHead]();
      this._header = head.toString('latin1');
      this[kConnSocket].write(Buffer.concat([head, body]));
    },

    [kWriteBody](buf, callback) {
      if (this._headerSent && this[kStreaming]) return this[kTrackWrite](buf, callback);
      this[kChunks].push(buf);
      // Content-Length known and socket up: start streaming now.
      if (!this._headerSent && this[kConnected] && rawHeader(this, 'content-length') != null) this[kFlushHead]();
      process.nextTick(callback);
      return true;
    },

    [kEndBody](buf) {
      this[kEnded] = true;
      if (buf) this[kWriteBody](buf, nop);
      if (this[kFetchMode]) {
        this[kSendViaFetch]();
      } else if (!this._headerSent) {
        // No Content-Length: buffer until end, then send with computed CL.
        if (this[kConnected]) this[kFlushHead]();
        // else: connect handler will flush once the socket is up
      } else if (this[kChunks].length && this[kStreaming]) {
        const data = Buffer.concat(this[kChunks]);
        this[kChunks] = [];
        this[kTrackWrite](data, nop);
      }
      this[kMaybeFinish]();
    },

    [kTrackWrite](buf, callback) {
      this[kPending] = (this[kPending] ?? 0) + 1;
      return socketWrite(this, this[kConnSocket], buf, (err) => {
        this[kPending]--;
        callback(err);
        this[kMaybeFinish]();
      });
    },

    [kMaybeFinish]() {
      if (!this.finished || this[kPending] || this[kFinishQueued]) return;
      this[kFinishQueued] = true;
      process.nextTick(() => {
        if (!this.destroyed) this[kFinish]();
      });
    },
  });

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
    return new ClientRequest(input, options, callback);
  }

  function get(input, options, callback) {
    const req = request(input, options, callback);
    req.end();
    return req;
  }

  const exports = {
    METHODS,
    STATUS_CODES,
    IncomingMessage,
    OutgoingMessage,
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
  httpInternals.set(exports, { storeHttpOptions, handleConnection });
  return exports;
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
