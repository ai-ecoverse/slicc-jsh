/**
 * node:http over net (ctx.net loopback) + IncomingMessage / ServerResponse.
 */
import { trackPromise } from '../async-handles.mjs';
import { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE, nodeError, validateBoolean, validateInteger, validateString } from '../node-errors.mjs';
import { EventEmitter } from './events.mjs';
import { createFetchClient, isLoopbackHost, kIncomingDestroy, kIncomingRead } from './http-fetch.mjs';
import { queueMicrotask, resourceHere, runInResource } from '../async-context.mjs';
import { writeRefusal } from './net.mjs';

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
const kRawHeaders = Symbol('kRawHeaders');
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
const kOnKeylog = Symbol('onkeylog');
const kHandoff = Symbol('kHandoff');
const kOpts = Symbol('kOpts');
const kChunks = Symbol('kChunks');
const kConnSocket = Symbol('kConnSocket');
const kConnected = Symbol('kConnected');
const kEnded = Symbol('kEnded');
const kStreaming = Symbol('kStreaming');
const kFlushAsked = Symbol('kFlushAsked');
const kChunkedOut = Symbol('kChunkedOut');
const kResource = Symbol('kResource');
const kAbortBody = Symbol('kAbortBody');
const kHangUp = Symbol('kHangUp');
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
const kBuffered = Symbol('kBuffered');
export const kFetchVia = Symbol('slicc-jsh.http.fetchVia');
export const httpInternals = new WeakMap();

function setRawHeader(msg, name, value) {
  if (msg[kRawHeaders]) msg[kRawHeaders].push([name, value]);
  else (msg[kOutHeaders] ??= Object.create(null))[name.toLowerCase()] = [name, value];
}

function rawHeader(msg, key) {
  if (msg[kRawHeaders]) return msg[kRawHeaders].find(([name]) => String(name).toLowerCase() === key)?.[1];
  return msg[kOutHeaders]?.[key]?.[1];
}

function headerPairs(headers) {
  let pairs = headers;
  if (!headers.length || !Array.isArray(headers[0])) {
    if (headers.length % 2 !== 0) throw ERR_INVALID_ARG_VALUE('headers', headers);
    pairs = [];
    for (let n = 0; n < headers.length; n += 2) pairs.push([headers[n], headers[n + 1]]);
  }
  for (const [name, value] of pairs) {
    validateHeaderName(name);
    validateHeaderValue(name, value);
  }
  return pairs.map(([name, value]) => [name, value]);
}

function headerObject(pairs) {
  const out = {};
  for (const [name, value] of pairs) {
    const key = String(name).toLowerCase();
    out[key] = key in out ? [].concat(out[key], value) : value;
  }
  return out;
}

const MAX_HEADER_SIZE = 16384;
const CL_MAX = 0xffffffffffffffffn;
const TCHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;

function hpe(code, reason, bytesParsed, packet) {
  return Object.assign(new Error(`Parse Error: ${reason}`), {
    bytesParsed,
    code,
    reason,
    rawPacket: packet,
  });
}

function isMethodChar(c) {
  return (c >= 'A' && c <= 'Z') || c === '-';
}

function parseContentLength(value) {
  const v = String(value).trim();
  if (v === '') return { error: hpe('HPE_INVALID_CONTENT_LENGTH', 'Empty Content-Length') };
  if (!/^\d+$/.test(v)) return { error: hpe('HPE_INVALID_CONTENT_LENGTH', 'Invalid character in Content-Length') };
  const n = BigInt(v);
  if (n > CL_MAX) return { error: hpe('HPE_INVALID_CONTENT_LENGTH', 'Content-Length overflow') };
  return { n };
}

function teTokens(value) {
  const tokens = [];
  for (const part of String(value).split(',')) tokens.push(part.trim());
  return tokens;
}

function classifyTransferEncoding(values) {
  let seenChunked = false;
  let any = false;
  for (const value of values) {
    if (String(value).trim() === '') continue;
    for (const token of teTokens(value)) {
      if (token === '') {
        if (seenChunked) return { error: hpe('HPE_INVALID_TRANSFER_ENCODING', 'Invalid `Transfer-Encoding` header value'), when: 'before' };
        continue;
      }
      const lower = token.toLowerCase();
      if (!/^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/.test(lower)) {
        if (seenChunked) return { error: hpe('HPE_INVALID_TRANSFER_ENCODING', 'Invalid `Transfer-Encoding` header value'), when: 'before' };
        return { error: hpe('HPE_INVALID_TRANSFER_ENCODING', 'Request has invalid `Transfer-Encoding`'), when: 'after' };
      }
      any = true;
      if (seenChunked) return { error: hpe('HPE_INVALID_TRANSFER_ENCODING', 'Invalid `Transfer-Encoding` header value'), when: 'before' };
      if (lower === 'chunked') seenChunked = true;
    }
  }
  if (!any) {
    const present = values.some((value) => String(value).trim() !== '');
    if (!present) return { chunked: false };
    return { error: hpe('HPE_INVALID_TRANSFER_ENCODING', 'Request has invalid `Transfer-Encoding`'), when: 'after' };
  }
  if (!seenChunked) return { error: hpe('HPE_INVALID_TRANSFER_ENCODING', 'Request has invalid `Transfer-Encoding`'), when: 'after' };
  return { chunked: true };
}

const URL_CHAR = "!\"$%&'()*+,-./:;<=>@[\\]^_`{|}~";
const USERINFO = "-_.!~*'()%;:&=+$,";

function isUrlChar(c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || URL_CHAR.includes(c);
}

function isUserInfo(c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || USERINFO.includes(c);
}

function urlError(reason) {
  return { error: hpe('HPE_INVALID_URL', reason) };
}

function parseFragment(line, i) {
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') return { i };
    if (c === '\t' || c === '\f') return urlError('Invalid characters in url');
    if (c === '?' || c === '#' || isUrlChar(c)) {
      i++;
      continue;
    }
    return urlError('Invalid char in url fragment start');
  }
  return { i };
}

function parseQuery(line, i) {
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') return { i };
    if (c === '\t' || c === '\f') return urlError('Invalid characters in url');
    if (c === '#') return parseFragment(line, i + 1);
    if (c === '?' || isUrlChar(c)) {
      i++;
      continue;
    }
    return urlError('Invalid char in url query');
  }
  return { i };
}

function parsePath(line, i) {
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') return { i };
    if (c === '\t' || c === '\f') return urlError('Invalid characters in url');
    if (c === '?') return parseQuery(line, i + 1);
    if (c === '#') return parseFragment(line, i + 1);
    if (isUrlChar(c)) {
      i++;
      continue;
    }
    return urlError('Invalid char in url path');
  }
  return { i };
}

function parseServer(line, i) {
  let at = false;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') return { i };
    if (c === '\t' || c === '\f') return urlError('Invalid characters in url');
    if (c === '/') return parsePath(line, i);
    if (c === '?') return parseQuery(line, i + 1);
    if (c === '@') {
      if (at) return urlError('Double @ in url');
      at = true;
      i++;
      continue;
    }
    if (c === '[' || c === ']' || isUserInfo(c)) {
      at = false;
      i++;
      continue;
    }
    return urlError('Unexpected char in url server');
  }
  return { i };
}

function parseRequestLine(line) {
  if (line.length === 0 || !isMethodChar(line[0])) return { error: hpe('HPE_INVALID_METHOD', 'Invalid method encountered') };
  let i = 0;
  let method = '';
  while (i < line.length && isMethodChar(line[i])) method += line[i++];
  if (!METHODS.includes(method)) {
    let known = method.length;
    while (known > 0 && !METHODS.some((m) => m.startsWith(method.slice(0, known)))) known--;
    const spaceExpected = METHODS.includes(method.slice(0, known));
    return { error: hpe('HPE_INVALID_METHOD', spaceExpected ? 'Expected space after method' : 'Invalid method encountered') };
  }
  if (line[i] !== ' ') return { error: hpe('HPE_INVALID_METHOD', 'Expected space after method') };
  while (line[i] === ' ') i++;
  if (i >= line.length) return { error: hpe('HPE_INVALID_URL', 'Invalid URL') };
  const urlStart = i;
  let urlEnd;
  if (method === 'CONNECT') {
    const got = parseServer(line, i);
    if (got.error) return got;
    urlEnd = got.i;
  } else if (line[i] === '/' || line[i] === '*') {
    const got = parsePath(line, i);
    if (got.error) return got;
    urlEnd = got.i;
  } else if ((line[i] >= 'A' && line[i] <= 'Z') || (line[i] >= 'a' && line[i] <= 'z')) {
    while (i < line.length && ((line[i] >= 'A' && line[i] <= 'Z') || (line[i] >= 'a' && line[i] <= 'z'))) i++;
    if (i >= line.length || line[i] === ' ' || line[i] === '\t' || line[i] === '\f') return urlError('Invalid characters in url');
    if (line[i] !== ':' || line[i + 1] !== '/' || line[i + 2] !== '/') return urlError('Unexpected char in url schema');
    i += 3;
    const got = parseServer(line, i);
    if (got.error) return got;
    urlEnd = got.i;
  } else return urlError('Unexpected start char in url');
  const url = line.slice(urlStart, urlEnd);
  i = urlEnd;
  if (i >= line.length) return { method, url, httpVersion: '0.9' };
  if (line[i] !== ' ') return { error: hpe('HPE_INVALID_URL', 'Invalid URL') };
  while (line[i] === ' ') i++;
  if (!line.startsWith('HTTP/', i)) return { error: hpe('HPE_INVALID_VERSION', 'Invalid HTTP version') };
  i += 5;
  const maj = i;
  while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
  if (i === maj || line[i] !== '.') return { error: hpe('HPE_INVALID_VERSION', 'Invalid HTTP version') };
  i++;
  if (i >= line.length || line[i] < '0' || line[i] > '9') return { error: hpe('HPE_INVALID_VERSION', 'Invalid HTTP version') };
  const version = `${line.slice(maj, i - 1)}.${line[i]}`;
  i++;
  if (i !== line.length) return { error: hpe('HPE_INVALID_VERSION', 'Expected CRLF after version') };
  if (version !== '1.0' && version !== '1.1' && version !== '2.0') return { error: hpe('HPE_INVALID_VERSION', 'Invalid HTTP version') };
  return { method, url, httpVersion: version };
}

function readHeadLine(bytes, i, first) {
  for (let j = i; j < bytes.length; j++) {
    if (bytes[j] === 0x0a) {
      if (!first && j === i) return { error: hpe('HPE_INVALID_HEADER_TOKEN', 'Invalid header field char') };
      if (j === i || bytes[j - 1] !== 0x0d) {
        return {
          error: hpe(
            first ? 'HPE_INVALID_VERSION' : 'HPE_CR_EXPECTED',
            first ? 'Expected CRLF after version' : 'Missing expected CR after header value',
          ),
        };
      }
      return { line: Buffer.from(bytes.subarray(i, j - 1)).toString('latin1'), next: j + 1 };
    }
    if (bytes[j] === 0x0d && j + 1 < bytes.length && bytes[j + 1] !== 0x0a) {
      return {
        error: hpe(
          first ? 'HPE_STRICT' : 'HPE_LF_EXPECTED',
          first ? 'Expected CRLF after version' : 'Missing expected LF after header value',
        ),
      };
    }
  }
  const end = bytes.length > i && bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length;
  return { need: true, partial: Buffer.from(bytes.subarray(i, end)).toString('latin1') };
}

function scanHeaderLine(line, first, partial) {
  if (line.length === 0) return { empty: true, count: 0 };
  const c0 = line.charCodeAt(0);
  if (c0 === 0x20 || c0 === 0x09) {
    return {
      count: 0,
      error: hpe(
        first ? 'HPE_UNEXPECTED_SPACE' : 'HPE_INVALID_HEADER_TOKEN',
        first ? 'Unexpected space after start line' : 'Unexpected whitespace after header value',
      ),
    };
  }
  let i = 0;
  while (i < line.length && TCHAR.test(line[i])) i++;
  if (i === line.length && partial) return { count: i };
  if (i === 0 || line[i] !== ':') return { count: i, error: hpe('HPE_INVALID_HEADER_TOKEN', 'Invalid header token') };
  let j = i + 1;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  const start = j;
  for (; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return { count: i + j - start, error: hpe('HPE_INVALID_HEADER_TOKEN', 'Invalid header value char') };
  }
  return { name: line.slice(0, i), value: line.slice(i + 1).trim(), count: i + line.length - start };
}

function targetCount(line) {
  let i = 0;
  while (i < line.length && isMethodChar(line[i])) i++;
  if (i === 0 || line[i] !== ' ') return 0;
  while (line[i] === ' ') i++;
  let n = 0;
  while (i + n < line.length && line[i + n] !== ' ') n++;
  return n;
}

const HTTP_VERSIONS = ['0.9', '1.0', '1.1', '2.0'];

function readStatusLine(bytes, i) {
  const fail = (code, reason, count = 0) => ({ error: hpe(code, reason), count });
  let p = i;
  const lead = bytes[p];
  if (lead === undefined) return { need: true, count: 0 };
  const prefix = lead === 0x48 ? 'HTTP/' : lead === 0x52 ? 'RTSP/' : lead === 0x49 ? 'ICE/' : '';
  if (!prefix) return fail('HPE_INVALID_CONSTANT', 'Expected HTTP/, RTSP/ or ICE/');
  for (let k = 0; k < prefix.length; k++, p++) {
    if (p >= bytes.length) return { need: true, count: 0 };
    if (bytes[p] !== prefix.charCodeAt(k)) return fail('HPE_INVALID_CONSTANT', 'Expected HTTP/, RTSP/ or ICE/');
  }
  const digit = (b) => b >= 0x30 && b <= 0x39;
  const steps = [
    [(b) => digit(b), 'Invalid major version'],
    [(b) => b === 0x2e, 'Expected dot'],
    [(b) => digit(b), 'Invalid minor version'],
  ];
  for (const [ok, reason] of steps) {
    if (p >= bytes.length) return { need: true, count: 0 };
    if (!ok(bytes[p])) return fail('HPE_INVALID_VERSION', reason);
    p++;
  }
  const httpVersion = `${String.fromCharCode(bytes[p - 3])}.${String.fromCharCode(bytes[p - 1])}`;
  if (!HTTP_VERSIONS.includes(httpVersion)) return fail('HPE_INVALID_VERSION', 'Invalid HTTP version');
  if (p >= bytes.length) return { need: true, count: 0 };
  if (bytes[p] !== 0x20) return fail('HPE_INVALID_VERSION', 'Expected space after version');
  p++;
  for (let k = 0; k < 3; k++, p++) {
    if (p >= bytes.length) return { need: true, count: 0 };
    if (!digit(bytes[p])) return fail('HPE_INVALID_STATUS', 'Invalid status code');
  }
  const statusCode = Number(Buffer.from(bytes.subarray(p - 3, p)).toString('latin1'));
  if (p >= bytes.length) return { need: true, count: 0 };
  let start = p;
  if (bytes[p] === 0x20) start = ++p;
  else if (bytes[p] !== 0x0d) return fail('HPE_INVALID_STATUS', 'Invalid response status');
  for (; p < bytes.length; p++) {
    if (bytes[p] === 0x0a) return fail('HPE_CR_EXPECTED', 'Missing expected CR after response line', p - start);
    if (bytes[p] !== 0x0d) continue;
    if (p + 1 >= bytes.length) break;
    if (bytes[p + 1] !== 0x0a) return fail('HPE_STRICT', 'Expected LF after CR', p - start);
    const statusMessage = Buffer.from(bytes.subarray(start, p)).toString('latin1');
    return { httpVersion, statusCode, statusMessage, next: p + 2, count: p - start };
  }
  return { need: true, count: p - start };
}

function requestFraming(rawHeaders, packet, bytesParsed) {
  const clValues = [];
  const teValues = [];
  let sawCL = false;
  let sawTE = false;
  let conflict = null;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = String(rawHeaders[i]).toLowerCase();
    if (key === 'transfer-encoding') {
      const value = rawHeaders[i + 1];
      const blank = String(value).trim() === '';
      if (sawCL && !conflict) conflict = hpe('HPE_INVALID_TRANSFER_ENCODING', "Transfer-Encoding can't be present with Content-Length", bytesParsed, packet);
      if (blank) continue;
      sawTE = true;
      teValues.push(value);
      const part = classifyTransferEncoding(teValues);
      if (part.error && part.error.reason !== 'Request has invalid `Transfer-Encoding`' && !conflict) conflict = part.error;
    } else if (key === 'content-length') {
      if (sawTE && !conflict) conflict = hpe('HPE_INVALID_CONTENT_LENGTH', "Content-Length can't be present with Transfer-Encoding", bytesParsed, packet);
      sawCL = true;
      clValues.push(rawHeaders[i + 1]);
    }
  }
  const te = sawTE ? classifyTransferEncoding(teValues) : { chunked: false };
  if (conflict && conflict.reason !== 'Request has invalid `Transfer-Encoding`') return { error: conflict };
  if (clValues.length > 1) return { error: hpe('HPE_UNEXPECTED_CONTENT_LENGTH', 'Duplicate Content-Length', bytesParsed, packet) };
  let contentLength = null;
  if (clValues.length === 1) {
    const parsed = parseContentLength(clValues[0]);
    if (parsed.error) return { error: Object.assign(parsed.error, { bytesParsed, rawPacket: packet }) };
    contentLength = parsed.n;
  }
  if (te.error) return te.error.reason === 'Request has invalid `Transfer-Encoding`' ? { teAfter: te.error, contentLength } : { error: te.error };
  return { chunked: te.chunked === true, contentLength: te.chunked ? null : (contentLength ?? 0n) };
}

const MAX_CHUNK_EXTENSIONS = 16384;

function isTcharByte(b) {
  return b < 0x80 && TCHAR.test(String.fromCharCode(b));
}

function hexValue(b) {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x37;
  if (b >= 0x61 && b <= 0x66) return b - 0x57;
  return -1;
}

function scanChunkSize(st, buf) {
  const fail = (code, reason) => ({ error: hpe(code, reason) });
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    const hex = hexValue(b);
    switch (st.state) {
      case undefined:
        if (hex < 0) return fail('HPE_INVALID_CHUNK_SIZE', 'Invalid character in chunk size');
        st.size = BigInt(hex);
        st.ext = 0;
        st.state = 'size';
        continue;
      case 'size':
        if (hex >= 0) {
          st.size = st.size * 16n + BigInt(hex);
          if (st.size > CL_MAX) return fail('HPE_INVALID_CHUNK_SIZE', 'Chunk size overflow');
        } else if (b === 0x0d) st.state = 'almost';
        else if (b === 0x0a) return fail('HPE_CR_EXPECTED', 'Missing expected CR after chunk size');
        else if (b === 0x3b) st.state = 'exts';
        else return fail('HPE_INVALID_CHUNK_SIZE', 'Invalid character in chunk size');
        continue;
      case 'exts':
        if (b === 0x0d || b === 0x20) return fail('HPE_STRICT', 'Invalid character in chunk extensions');
        st.state = 'name';
        i--;
        continue;
      case 'name':
        if (b === 0x0a) return fail('HPE_CR_EXPECTED', 'Missing expected CR after chunk extension name');
        if (b === 0x0d) st.state = 'almost';
        else if (b === 0x3b) st.state = 'exts';
        else if (b === 0x3d) st.state = 'value';
        else if (isTcharByte(b)) st.ext++;
        else return fail('HPE_STRICT', 'Invalid character in chunk extensions name');
        break;
      case 'value':
        if (b === 0x0a) return fail('HPE_CR_EXPECTED', 'Missing expected CR after chunk extension value');
        if (b === 0x0d) st.state = 'almost';
        else if (b === 0x3b) st.state = 'exts';
        else if (b === 0x22) {
          st.ext++;
          st.state = 'quoted';
        } else if (isTcharByte(b)) st.ext++;
        else return fail('HPE_STRICT', 'Invalid character in chunk extensions value');
        break;
      case 'quoted':
        if ((b < 0x20 && b !== 0x09) || b > 0xff) return fail('HPE_STRICT', 'Invalid character in chunk extensions quoted value');
        st.ext++;
        if (b === 0x22) st.state = 'unquoted';
        else if (b === 0x5c) st.state = 'pair';
        break;
      case 'pair':
        if ((b < 0x20 && b !== 0x09) || b === 0x7f) return fail('HPE_STRICT', 'Invalid quoted-pair in chunk extensions quoted value');
        st.ext++;
        st.state = 'quoted';
        break;
      case 'unquoted':
        if (b === 0x0a) return fail('HPE_CR_EXPECTED', 'Missing expected CR after chunk extension value');
        if (b === 0x0d) st.state = 'almost';
        else if (b === 0x3b) st.state = 'exts';
        else return fail('HPE_STRICT', 'Invalid character in chunk extensions quote value');
        continue;
      default:
        if (b !== 0x0a) return fail('HPE_STRICT', 'Expected LF after chunk size');
        st.state = undefined;
        return { size: st.size, used: i + 1 };
    }
    if (st.ext > MAX_CHUNK_EXTENSIONS) return fail('HPE_CHUNK_EXTENSIONS_OVERFLOW', 'Chunk extensions overflow');
  }
  return { need: true };
}

function readTrailer(st, buf, limit) {
  const overflow = () => ({ error: hpe('HPE_HEADER_OVERFLOW', 'Header overflow') });
  for (let j = 0; j < buf.length; j++) {
    if (buf[j] === 0x0a) {
      if (j === 0) return { error: hpe('HPE_INVALID_HEADER_TOKEN', 'Invalid header field char') };
      if (buf[j - 1] !== 0x0d) return { error: hpe('HPE_CR_EXPECTED', 'Missing expected CR after header value') };
      const rest = Buffer.from(buf.subarray(j + 1));
      if (j === 1) return { done: true, rest };
      const header = scanHeaderLine(Buffer.from(buf.subarray(0, j - 1)).toString('latin1'), false);
      if (st.size + header.count >= limit) return overflow();
      if (header.error) return { error: header.error };
      st.size += header.count;
      return { header, rest };
    }
    if (buf[j] === 0x0d && j + 1 < buf.length && buf[j + 1] !== 0x0a) return { error: hpe('HPE_LF_EXPECTED', 'Missing expected LF after header value') };
  }
  const end = buf.length > 0 && buf[buf.length - 1] === 0x0d ? buf.length - 1 : buf.length;
  const header = scanHeaderLine(Buffer.from(buf.subarray(0, end)).toString('latin1'), false, true);
  if (st.size + header.count >= limit) return overflow();
  if (header.error) return { error: header.error };
  return { wait: true, rest: squeezeLine(buf, 'header') };
}

const MAX_UNCOUNTED_START = 64;

function squeezeLine(bytes, kind) {
  const text = Buffer.from(bytes).toString('latin1');
  const colon = text.indexOf(':');
  let out = text;
  if (kind === 'request') out = text.replace(/ {2,}/g, ' ');
  else if (colon >= 0) out = text.slice(0, colon + 1) + text.slice(colon + 1).replace(/^[ \t]+/, ' ');
  return Buffer.from(out, 'latin1');
}

function responseFraming(rawHeaders, packet, bytesParsed) {
  const clValues = [];
  const teValues = [];
  let sawCL = false;
  let sawTE = false;
  let conflict = null;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = String(rawHeaders[i]).toLowerCase();
    if (key === 'transfer-encoding') {
      const value = rawHeaders[i + 1];
      const blank = String(value).trim() === '';
      if (sawCL && !conflict) conflict = hpe('HPE_INVALID_TRANSFER_ENCODING', "Transfer-Encoding can't be present with Content-Length", bytesParsed, packet);
      if (blank) continue;
      sawTE = true;
      teValues.push(value);
    } else if (key === 'content-length') {
      if (sawTE && !conflict) conflict = hpe('HPE_INVALID_CONTENT_LENGTH', "Content-Length can't be present with Transfer-Encoding", bytesParsed, packet);
      sawCL = true;
      clValues.push(rawHeaders[i + 1]);
    }
  }
  if (conflict) return { error: conflict };
  if (clValues.length > 1) return { error: hpe('HPE_UNEXPECTED_CONTENT_LENGTH', 'Duplicate Content-Length', bytesParsed, packet) };
  let contentLength = null;
  if (clValues.length === 1) {
    const parsed = parseContentLength(clValues[0]);
    if (parsed.error) return { error: Object.assign(parsed.error, { bytesParsed, rawPacket: packet }) };
    contentLength = parsed.n;
  }
  const last = teValues.length > 0 ? teTokens(teValues[teValues.length - 1]) : [];
  const chunked = last.length > 0 && last[last.length - 1].toLowerCase() === 'chunked';
  return { chunked, contentLength: chunked ? null : contentLength };
}

/**
 * Parse HTTP/1.x head from a byte buffer; returns null if incomplete, with
 * st.rest the bytes to keep for the next call (the lines before it are in st).
 */
function parseHead(buf, Buffer, kind = 'request', limit = MAX_HEADER_SIZE, st = {}) {
  const bytes = buf instanceof Uint8Array ? buf : Buffer.from(buf);
  let i = 0;
  const rawHeaders = (st.rawHeaders ??= []);
  const fail = (error) => ({ kind, error, rawHeaders, bodyPrefix: Buffer.alloc(0) });
  const overflow = () => fail(hpe('HPE_HEADER_OVERFLOW', 'Header overflow'));
  const wait = (from, squeeze) => {
    st.rest = squeeze ? squeezeLine(bytes.subarray(from), squeeze) : Buffer.from(bytes.subarray(from));
    return null;
  };
  if (!st.start) {
    while (i < bytes.length && (bytes[i] === 0x0d || bytes[i] === 0x0a)) i++;
    if (kind === 'response') {
      const start = readStatusLine(bytes, i);
      if (start.count >= limit) return overflow();
      if (start.error) return fail(start.error);
      if (start.need) return wait(i);
      st.start = start;
    } else {
      const got = readHeadLine(bytes, i, true);
      const line = got.line ?? got.partial?.replace(/ {2,}/g, ' ') ?? '';
      const count = targetCount(line);
      if (count >= limit) return overflow();
      if (got.error) return fail(got.error);
      if (got.need) {
        if (line.length - count <= MAX_UNCOUNTED_START) return wait(i, 'request');
        return fail(parseRequestLine(line).error ?? hpe('HPE_INVALID_VERSION', 'Expected CRLF after version'));
      }
      const start = parseRequestLine(line);
      if (start.error) return fail(start.error);
      st.start = Object.assign(start, { count, next: got.next });
    }
    st.size = st.start.count;
    st.first = true;
    i = st.start.next;
  }
  const start = st.start;
  for (;;) {
    const got = readHeadLine(bytes, i, false);
    if (got.error) return fail(got.error);
    if (got.line === '') {
      const bodyPrefix = Buffer.from(bytes.subarray(got.next));
      const framed = (kind === 'response' ? responseFraming : requestFraming)(rawHeaders, bytes, got.next);
      const head = {
        error: framed.error ?? null,
        kind,
        rawHeaders,
        bodyPrefix,
        chunked: framed.chunked === true,
        contentLength: framed.contentLength ?? null,
        httpVersion: start.httpVersion,
      };
      if (kind === 'response') return Object.assign(head, { statusCode: start.statusCode, statusMessage: start.statusMessage });
      return Object.assign(head, { teAfter: framed.teAfter ?? null, method: start.method, url: start.url });
    }
    const header = scanHeaderLine(got.line ?? got.partial, st.first, got.need);
    if (st.size + header.count >= limit) return overflow();
    if (header.error) return fail(header.error);
    if (got.need) return wait(i, 'header');
    rawHeaders.push(header.name, header.value);
    st.size += header.count;
    st.first = false;
    i = got.next;
  }
}

function unsigned64(text) {
  const [, sign, digits] = /^\s*([+-]?)(\d*)/.exec(text);
  const n = BigInt(digits || '0');
  if (n >= 2n ** 64n) return Number(2n ** 64n - 1n);
  return Number(sign === '-' ? (2n ** 64n - n) % 2n ** 64n : n);
}

function errorResponse(code) {
  if (code === 'HPE_HEADER_OVERFLOW') return 'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n';
  if (code === 'HPE_CHUNK_EXTENSIONS_OVERFLOW') return 'HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\n\r\n';
  return 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n';
}

/** Max buffered HTTP body (request or response). Over → 413 / error. */
export const MAX_HTTP_BODY = 64 * 1024 * 1024;

const SETTLE_TURNS = 6;

const CRLF = new Uint8Array([13, 10]);
const RE_CONN_CLOSE = /(?:^|\W)close(?:$|\W)/i;
const RE_TE_CHUNKED = /(?:^|\W)chunked(?:$|\W)/i;

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
  let headerSize;
  const maxHeaderSize = () => {
    if (headerSize !== undefined) return headerSize;
    const argv = process?._options ?? process?.execArgv ?? [];
    let value;
    for (let n = 0; n < argv.length; n++) {
      const flag = String(argv[n]);
      if (flag === '--max-http-header-size') value = String(argv[++n]);
      else if (flag.startsWith('--max-http-header-size=')) value = flag.slice(23);
    }
    headerSize = value === undefined ? MAX_HEADER_SIZE : unsigned64(value);
    return headerSize;
  };
  let fetchClient;
  const getFetchClient = () => (fetchClient ??= createFetchClient({ ctx, Buffer, handles, STATUS_CODES, getFetch, IncomingMessage }));

  const Stream = stream.Stream;
  const nop = () => {};
  const chunkFrame = (buf) => (buf.length ? Buffer.concat([Buffer.from(`${buf.length.toString(16)}\r\n`), buf, Buffer.from('\r\n')]) : buf);
  const armChunked = (req) => {
    if (rawHeader(req, 'content-length') != null || req[kChunkedOut]) return;
    const teRaw = rawHeader(req, 'transfer-encoding');
    const method = String(req[kOpts].method ?? 'GET').toUpperCase();
    const bodiless = ['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'].includes(method);
    const want = teRaw == null ? !bodiless : classifyTransferEncoding([String(teRaw)])?.chunked === true;
    if (!want) return;
    if (teRaw == null) setRawHeader(req, 'Transfer-Encoding', 'chunked');
    req[kChunkedOut] = true;
    req[kStreaming] = true;
  };

  function IncomingMessage(socket) {
    Readable.call(this, socket ? { highWaterMark: socket.readableHighWaterMark } : undefined);
    this._readableState.readingMore = true;
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
    if (!this._consuming) {
      this._readableState.readingMore = false;
      this._consuming = true;
    }
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
          if (!msg[kNeedDrain] || msg.finished) return;
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
    this[kHighWaterMark] = options?.highWaterMark ?? stream.getDefaultHighWaterMark(false);
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
      return this.outputSize + this[kChunkedLength] + (this[kBatch]?.size ?? 0) + (this[kBuffered] ?? 0) + (this.socket ? this.socket.writableLength : 0);
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
    let served = 0;
    let idleTimer = null;
    let headersTimer = null;
    const conn = { socket, idle: true };
    server._connections.add(conn);
    let requestTimer = null;
    let body = null;
    let current = null;
    let dead = false;
    let stopped = false;
    let closedAfter = false;
    let suppressWrite = false;
    const outgoing = [];
    const incoming = [];
    let head = {};
    let peerEnded = false;
    let eofDone = false;
    let running = false;
    let broken = false;
    let timedOut = null;
    socket.once('close', () => {
      server._connections.delete(conn);
      clearTimeout(idleTimer);
      clearTimeout(headersTimer);
      clearTimeout(requestTimer);
      for (const req of incoming.splice(0)) {
        if (!req.destroyed) req.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
      }
      const attached = socket._httpMessage ?? timedOut;
      if (attached instanceof ServerResponse) attached[kEmitClose]();
      server._connectionGone?.();
    });
    const destroy = () => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    };
    const destroySoon = () => {
      if (socket.writable) socket.end();
      if (socket.writableFinished) destroy();
      else socket.once('finish', destroy);
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
      if (socket.destroyed || dead) return;
      dead = true;
      body = null;
      clearTimeout(requestTimer);
      requestTimer = null;
      clearTimeout(headersTimer);
      headersTimer = null;
      const res = current?.res;
      if (res && !res.headersSent) {
        res.detachSocket(socket);
        timedOut = res;
      }
      current = null;
      if (server.listenerCount('clientError') > 0) {
        server.emit('clientError', nodeError(Error, 'ERR_HTTP_REQUEST_TIMEOUT', 'Request timeout'), socket);
        return;
      }
      if (res?.headersSent) {
        destroy();
        return;
      }
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
    const settle = async () => {
      for (let turn = 0; turn < SETTLE_TURNS; turn++) {
        process._tickCallback?.();
        await new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
      }
    };
    const execute = () => {
      running = true;
      for (;;) {
        let step;
        try {
          step = dead || stopped ? 'stop' : body ? body.step() : socket.destroyed ? 'stop' : buf.length > 0 ? parseOne() : 'wait';
        } catch (err) {
          running = false;
          throw err;
        }
        if (step === 'more') continue;
        if (step === 'drain') {
          settle()
            .then(() => runInResource(resource, execute, null, []))
            .catch((err) => {
              running = false;
              process._triggerUncaught(err);
            });
          return;
        }
        break;
      }
      running = false;
      eofSoon();
    };
    const eofSoon = () => {
      if (peerEnded && !eofDone) process.nextTick(eofCheck);
    };
    const eofCheck = () => {
      if (!peerEnded || eofDone || running || dead || socket.destroyed) return;
      if (broken) {
        eofDone = true;
        if (socket.writable) socket.end();
        return;
      }
      if (socket._httpMessage?.finished) return;
      eofDone = true;
      socket.off('data', onData);
      if (buf.length > 0 || head.start || body) {
        socketError(hpe('HPE_INVALID_EOF_STATE', 'Invalid EOF state'));
        return;
      }
      if (socket.writable) socket.end();
    };
    const skipLineEnds = () => {
      let at = 0;
      while (at < buf.length && (buf[at] === 0x0d || buf[at] === 0x0a)) at++;
      if (at > 0) buf = Buffer.from(buf.subarray(at));
    };
    const parseOne = () => {
      if (closedAfter) {
        skipLineEnds();
        if (buf.length === 0) return 'wait';
        stopped = true;
        const closed = hpe('HPE_CLOSED_CONNECTION', 'Data after `Connection: close`');
        if (server.listenerCount('clientError') > 0) server.emit('clientError', closed, socket);
        else socketError(closed);
        return 'stop';
      }
      armRequest();
      armHeaders();
      if (buf.length > MAX_HTTP_BODY + 64 * 1024) {
        // Cap head+body growth while still reading the request line/headers.
        rejectPayloadTooLarge(socket, onData);
        return 'stop';
      }
      const parsed = parseHead(buf, Buffer, 'request', server.maxHeaderSize || maxHeaderSize(), head);
      if (!parsed) {
        buf = head.rest;
        return 'wait';
      }
      head = {};
      if (parsed.kind !== 'request') return 'stop';
      clearTimeout(idleTimer);
      idleTimer = null;
      if (parsed.error) {
        broken = true;
        socket.off('data', onData);
        if (server.listenerCount('clientError') > 0) {
          server.emit('clientError', parsed.error, socket);
          return 'stop';
        }
        try {
          socket.end(errorResponse(parsed.error.code), destroy);
        } catch {
          destroy();
        }
        return 'stop';
      }
      // The headers are in: headersTimeout is done, the body has requestTimeout.
      clearTimeout(headersTimer);
      headersTimer = null;
      armRequest();
      const headers = headerObj(parsed.rawHeaders);
      const connectionTokens = String(headers.connection || '').toLowerCase();
      if (parsed.method === 'CONNECT') {
        clearTimeout(requestTimer);
        requestTimer = null;
        socket.off('data', onData);
        socket.off('end', onSocketEnd);
        socket.off('error', onSocketError);
        server._connections.delete(conn);
        buf = Buffer.alloc(0);
        stopped = true;
        if (server.listenerCount('connect') === 0) {
          destroy();
          return 'stop';
        }
        const req = makeIncomingMessage(socket, Buffer.alloc(0));
        setRequestLine(req, parsed, headers);
        socket.readableFlowing = null;
        server.emit('connect', req, socket, Buffer.from(parsed.bodyPrefix));
        return 'stop';
      }
      // Node: an Upgrade request goes to 'upgrade' listeners, with what
      // followed the head; with none, it is an ordinary request.
      if (headers.upgrade && /\bupgrade\b/.test(connectionTokens) && server.listenerCount('upgrade') > 0) {
        clearTimeout(headersTimer);
        headersTimer = null;
        clearTimeout(requestTimer);
        requestTimer = null;
        socket.off('data', onData);
        socket.off('end', onSocketEnd);
        socket.off('error', onSocketError);
        server._connections.delete(conn);
        const req = makeIncomingMessage(socket, Buffer.alloc(0));
        setRequestLine(req, parsed, headers);
        buf = Buffer.alloc(0);
        stopped = true;
        socket.readableFlowing = null;
        server.emit('upgrade', req, socket, Buffer.from(parsed.bodyPrefix));
        return 'stop';
      }
      if (parsed.httpVersion === '1.1' && parsed.method !== 'CONNECT' && server.requireHostHeader && headers.host === undefined) {
        clearTimeout(requestTimer);
        requestTimer = null;
        socket.off('data', onData);
        stopped = true;
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
        return 'stop';
      }
      const headLength = buf.length - parsed.bodyPrefix.length;
      const chunked = parsed.chunked === true;
      let left = chunked ? 0n : (parsed.contentLength ?? 0n);
      buf = Buffer.from(buf.subarray(headLength));
      conn.idle = false;
      served++;
      const req = new IncomingMessage(socket);
      const emit = req.emit;
      req.emit = function (...args) {
        return runInResource(resource, emit, this, args);
      };
      setRequestLine(req, parsed, headers);
      incoming.push(req);
      let bodyDone = false;
      let resDone = false;
      let handed = false;
      const chunk = { phase: 'size', left: 0n, trailers: null, line: {}, trailer: { size: 0 } };
      req[kIncomingRead] = () => {
        socket.resume?.();
      };
      req[kIncomingDestroy] = (err, callback) => {
        if (!req.readableEnded || !req.complete) {
          req.aborted = true;
          req.emit('aborted');
        }
        if (req.aborted && !socket.destroyed) {
          const done = () => callback(req.listenerCount('error') > 0 ? err : undefined);
          if (err) socket.once('error', done);
          socket.destroy(err);
          if (!err) done();
          return;
        }
        process.nextTick(() => callback(req.listenerCount('error') > 0 ? err : undefined));
      };
      const pushBody = (bytes) => {
        if (bytes.length === 0 || req._dumped) return;
        if (!req.push(Buffer.from(bytes))) socket.pause?.();
      };
      const complete = () => {
        bodyDone = true;
        body = null;
        clearTimeout(requestTimer);
        requestTimer = null;
        req.complete = true;
        if (res.shouldKeepAlive === false) skipLineEnds();
        if (buf.length > 0 && res.shouldKeepAlive === false) {
          stopped = true;
          incoming.splice(incoming.indexOf(req), 1);
          const closed = hpe('HPE_CLOSED_CONNECTION', 'Data after `Connection: close`');
          if (server.listenerCount('clientError') > 0) server.emit('clientError', closed, socket);
          else socketError(closed);
          if (!req.destroyed) req.push(null);
          handles?.notify?.();
          return;
        }
        if (res.shouldKeepAlive === false) closedAfter = true;
        req.push(null);
        socket.resume?.();
        handles?.notify?.();
        if (socket.destroyed || dead) return;
        if (resDone && res._last) {
          socket.unref?.();
          destroy();
          return;
        }
        if (resDone && !res._last) keptAlive();
      };
      const badBody = (code, reason) => {
        body = null;
        socketError(Object.assign(new Error(`Parse Error: ${reason}`), { code, reason }));
        return 'stop';
      };
      const step = () => {
        if (!chunked) {
          if (left > 0n && buf.length > 0) {
            const n = left > BigInt(buf.length) ? buf.length : Number(left);
            const take = buf.subarray(0, n);
            buf = Buffer.from(buf.subarray(n));
            left -= BigInt(n);
            pushBody(take);
            return 'drain';
          }
          if (left > 0n) return 'wait';
          complete();
          return 'more';
        }
        for (;;) {
          if (chunk.phase === 'size') {
            const line = scanChunkSize(chunk.line, buf);
            if (line.error) return badBody(line.error.code, line.error.reason);
            if (line.need) {
              buf = Buffer.alloc(0);
              return 'wait';
            }
            buf = Buffer.from(buf.subarray(line.used));
            if (line.size === 0n) chunk.phase = 'trailer';
            else {
              chunk.left = line.size;
              chunk.phase = 'data';
            }
          } else if (chunk.phase === 'trailer') {
            const line = readTrailer(chunk.trailer, buf, server.maxHeaderSize || maxHeaderSize());
            if (line.wait) {
              buf = line.rest;
              return 'wait';
            }
            if (line.error) return badBody(line.error.code, line.error.reason);
            buf = line.rest;
            if (line.done) {
              req.rawTrailers = chunk.trailers ?? [];
              req[kTrailers] = null;
              complete();
              return 'more';
            }
            const name = line.header.name.toLowerCase();
            if (name === 'transfer-encoding') return badBody('HPE_INVALID_TRANSFER_ENCODING', 'Invalid `Transfer-Encoding` header value');
            if (name === 'content-length') return badBody('HPE_INVALID_CONTENT_LENGTH', "Content-Length can't be present with Transfer-Encoding");
            (chunk.trailers ??= []).push(line.header.name, line.header.value);
          } else if (chunk.phase === 'data') {
            if (buf.length === 0) return 'wait';
            const n = chunk.left > BigInt(buf.length) ? buf.length : Number(chunk.left);
            const take = buf.subarray(0, n);
            buf = Buffer.from(buf.subarray(n));
            chunk.left -= BigInt(n);
            pushBody(take);
            if (chunk.left === 0n) chunk.phase = 'cr';
            return 'drain';
          } else if (chunk.phase === 'cr') {
            if (buf.length === 0) return 'wait';
            const b = buf[0];
            if (b === 0x0a) return badBody('HPE_CR_EXPECTED', 'Missing expected CR after chunk data');
            if (b !== 0x0d) return badBody('HPE_STRICT', 'Expected LF after chunk data');
            buf = Buffer.from(buf.subarray(1));
            chunk.phase = 'lf';
          } else {
            if (buf.length === 0) return 'wait';
            if (buf[0] !== 0x0a) return badBody('HPE_STRICT', 'Expected LF after chunk data');
            buf = Buffer.from(buf.subarray(1));
            chunk.phase = 'size';
          }
        }
      };
      const res = new ServerResponse(req);
      if (!suppressWrite && !socket.destroyed && !socket._httpMessage) res.assignSocket(socket);
      else outgoing.push(res);
      const entry = { req, res, step };
      current = entry;
      // Node's shouldKeepAlive: HTTP/1.1 unless the client says close, and
      // below maxRequestsPerSocket. A connection that is open when close()
      // is called keeps serving as before (Node 22): it closes when idle.
      const max = server.maxRequestsPerSocket;
      const tokens = connectionTokens.split(',').map((token) => token.trim());
      const persistent = req.httpVersionMajor > 0 && req.httpVersionMinor > 0 ? !tokens.includes('close') : tokens.includes('keep-alive');
      res.shouldKeepAlive = persistent && !(max > 0 && served >= max);
      res._keepAliveTimeout = server.keepAliveTimeout;
      res._maxRequestsPerSocket = max;
      const keptAlive = () => {
        if (handed) return;
        handed = true;
        const ahead = current !== entry;
        if (!ahead) {
          current = null;
          conn.idle = true;
        }
        const next = outgoing.shift();
        if (next && !suppressWrite && !socket.destroyed && !socket._httpMessage) next.assignSocket(socket);
        if (!ahead && !next) armIdle();
      };
      res.on('finish', () => {
        resDone = true;
        if (incoming.includes(req)) incoming.splice(incoming.indexOf(req), 1);
        if (!req._consuming && !req._readableState.resumeScheduled) req._dump();
        res.detachSocket(socket);
        process.nextTick(() => res[kEmitClose]());
        if (socket.destroyed || dead) return;
        if (!res._last) {
          if (bodyDone) keptAlive();
          eofSoon();
          return;
        }
        suppressWrite = true;
        if (server._closing) closeGracefully(socket);
        else {
          socket.unref?.();
          destroySoon();
        }
      });
      body = parsed.teAfter ? null : entry;
      const expect = headers.expect;
      if (expect !== undefined && req.httpVersionMajor === 1 && req.httpVersionMinor === 1) {
        if (/(?:^|\W)100-continue(?:$|\W)/i.test(String(expect).trim())) {
          if (server.listenerCount('checkContinue') > 0) server.emit('checkContinue', req, res);
          else {
            res.writeContinue();
            emitRequest(req, res);
          }
        } else if (server.listenerCount('checkExpectation') > 0) server.emit('checkExpectation', req, res);
        else {
          res.writeHead(417);
          res.end();
        }
      } else emitRequest(req, res);
      if (parsed.teAfter) {
        socketError(parsed.teAfter);
        return 'stop';
      }
      return 'more';
    };
    const emitRequest = (req, res) => {
      server.emit('request', req, res);
      if (typeof requestListener === 'function') requestListener(req, res);
    };
    const socketError = (err) => {
      broken = true;
      socket.off('data', onData);
      if (server.listenerCount('clientError') > 0) {
        server.emit('clientError', err, socket);
        return;
      }
      if (socket.writable && !(current?.res?.headersSent)) {
        try {
          socket.end(errorResponse(err.code), () => socket.destroy(err));
          return;
        } catch {
          /* ignore */
        }
      }
      socket.destroy(err);
    };
    const onData = (chunk) => {
      if (dead || socket.destroyed) return;
      if (idleTimer) armIdle();
      if (!current && !body && buf.length === 0) armRequest();
      buf = Buffer.concat([buf, chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(chunk)]);
      if (!running) runInResource(resource, execute, null, []);
    };
    const onSocketEnd = () => {
      peerEnded = true;
      eofCheck();
    };
    const onSocketError = (err) => server.emit('clientError', err, socket);
    socket.on('end', onSocketEnd);
    socket.on('data', onData);
    socket.on('error', onSocketError);
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
    self.on('connection', function connectionListener(socket) {
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
    if (options?.maxHeaderSize !== undefined) validateInteger(options.maxHeaderSize, 'maxHeaderSize', 0);
    self.maxHeaderSize = options?.maxHeaderSize;
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
    this.on('newListener', maybeEnableKeylog);
  }
  function freeSocketErrorListener() {
    this.destroy();
    this.emit('agentRemove');
  }
  function maybeEnableKeylog(eventName) {
    if (eventName !== 'keylog') return;
    this.removeListener('newListener', maybeEnableKeylog);
    const agent = this;
    this[kOnKeylog] = function onkeylog(keylog) {
      agent.emit('keylog', keylog, this);
    };
    for (const list of Object.values(this.sockets)) for (const s of list) s.on('keylog', this[kOnKeylog]);
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
      if (socket.destroyed || !socket._httpMessage?.shouldKeepAlive || !this.keepAlive || !(this.maxFreeSockets > 0) || free.length >= this.maxFreeSockets || !this.keepSocketAlive(socket)) {
        if (!free.length) delete this.freeSockets[name];
        socket.destroy();
        return;
      }
      const list = this.sockets[name];
      const i = list ? list.indexOf(socket) : -1;
      if (i !== -1) list.splice(i, 1);
      if (list && !list.length) delete this.sockets[name];
      socket.once('error', freeSocketErrorListener);
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
      socket.removeListener('error', freeSocketErrorListener);
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
        const onClose = () => this.removeSocket(s, options);
        const onFree = () => this.emit('free', s, options);
        // A free socket that idles past the agent's timeout goes (Node's onTimeout).
        const onTimeout = () => {
          if (this.freeSockets[name]?.includes(s)) s.destroy();
        };
        const onRemove = () => {
          this.removeSocket(s, options);
          s.removeListener('close', onClose);
          s.removeListener('free', onFree);
          s.removeListener('timeout', onTimeout);
          s.removeListener('agentRemove', onRemove);
        };
        s.once?.('close', onClose);
        s.on?.('free', onFree);
        s.on?.('timeout', onTimeout);
        s.on?.('agentRemove', onRemove);
        if (this[kOnKeylog]) s.on?.('keylog', this[kOnKeylog]);
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
    this.aborted = false;
    if (options.maxHeaderSize !== undefined) validateInteger(options.maxHeaderSize, 'maxHeaderSize', 0);
    this.maxHeaderSize = options.maxHeaderSize;
    // Node's: what the request is, readable as res.req's.
    this.method = String(options.method ?? 'GET').toUpperCase();
    this.path = options.path ?? '/';
    this.host = options.hostname ?? options.host ?? 'localhost';
    this.protocol = options.protocol ?? 'http:';
    this[kRawHeaders] = Array.isArray(options.headers) ? headerPairs(options.headers) : null;
    if (!this[kRawHeaders]) for (const [k, v] of Object.entries(options.headers ?? {})) this.setHeader(k, v);
    // Node: keep-alive when the agent keeps sockets (the global agent does).
    // With its own createConnection and no agent, a request has no agent
    // (Node's ClientRequest); https hands in its own default agent.
    const defaultAgent = options._defaultAgent ?? globalAgent;
    const agent =
      options.agent === false
        ? null
        : (options.agent ?? (typeof options.createConnection === 'function' ? null : defaultAgent));
    this.agent = agent ?? undefined;
    this.shouldKeepAlive = Boolean(agent && (agent.keepAlive || Number.isFinite(agent.maxSockets)));
    // Node's: Host is set here, after the given headers, so an agent's
    // addRequest sees it (http-proxy-agent builds the absolute URL from it).
    if (!this[kRawHeaders] && !this.hasHeader('host') && options.setHost !== false) {
      let hostHeader = String(options.hostname ?? options.host ?? 'localhost');
      const colon = hostHeader.indexOf(':');
      if (colon !== -1 && hostHeader.includes(':', colon + 1) && hostHeader[0] !== '[') hostHeader = `[${hostHeader}]`;
      const defaultPort = options.defaultPort || agent?.defaultPort || 80;
      if (options.port && +options.port !== defaultPort) hostHeader += `:${options.port}`;
      setRawHeader(this, 'Host', hostHeader);
    }
    if (this[kRawHeaders]) this._header = this[kRenderHead]().toString('latin1');
    if (cb) this.once('response', cb);
    this[kConnect]();
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
      this.aborted = true;
      this.destroy();
    },
    clearTimeout(callback) {
      return this.setTimeout(0, callback);
    },
    flushHeaders() {
      if (this[kFetchVia] || this[kFetchMode]) return;
      this[kFlushAsked] = true;
      armChunked(this);
      if (this[kConnected]) this[kFlushHead]();
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
      process.nextTick(() => {
        if (err) emitError(this, err);
        else if (!this.destroyed) this[kAttachSocket](socket);
        else {
          if (this.agent && !socket.destroyed) socket.emit('free');
          else socket.destroy();
          if (!this.aborted && !this[kErrored]) emitError(this, Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
        }
      });
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
            this.onSocket(socket);
          };
          const { signal: _signal, ...withoutSignal } = { ...opts, ...options };
          void _signal;
          const socket = opts.createConnection(withoutSignal, oncreate);
          if (socket) oncreate(null, socket);
          return;
        }
        const connectOpts = { host, port };
        if (options.socketPath) connectOpts.path = options.socketPath;
        this.onSocket(net.connect(connectOpts));
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
      const headerLimit = this.maxHeaderSize || maxHeaderSize();
      let headBuf = Buffer.alloc(0);
      let head = {};
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
        const wrote = !this[kConnected] && (this[kEnded] || this[kFlushAsked] || this[kChunkedOut] || this[kChunks].length > 0);
        emitError(this, resetOfReused(this, wrote ? writeRefusal(err) : err));
        // Node: 'error', then the request's 'close'.
        if (!this.destroyed) this.destroy();
      });
      const onReady = () => {
        this[kConnected] = true;
        if (rawHeader(this, 'content-length') != null || this[kEnded] || this[kFlushAsked] || this[kChunkedOut] || this[kChunks].length) this[kFlushHead]();
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
      let released = false;
      let awaitingFinish = false;
      let cut = false;
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
      };
      // Keep-alive: a framed response the server didn't end the connection
      // with goes back to the agent ('free'), for the next request.
      const reusable = () =>
        Boolean(
          this.agent &&
          this.shouldKeepAlive &&
          framing.kind !== 'eof' &&
          res.httpVersion !== '1.0' &&
          !/\bclose\b/i.test(String(res.headers.connection ?? '')) &&
          !socketEnded &&
          (!socket.destroyed || cut) &&
          // An agent that didn't make the socket (its own createSocket) has no pool for it.
          socket.listenerCount('free') > 0
        );
      const keepAlive = () => {
        if (released) return;
        released = true;
        unlisten();
        this[kConnSocket] = null;
        this.destroyed = true;
        res.socket = null;
        process.nextTick(() => {
          this._closed = true;
          this.emit('close');
          if (!socket.destroyed) socket.emit('free');
          if (socket._httpMessage === this) socket._httpMessage = null;
          handles?.notify?.();
        });
      };
      const onResponseEnd = () => {
        if (released) return;
        if (!reusable()) {
          released = true;
          quietClose();
        } else if (this.writableFinished && !this.aborted) keepAlive();
        else {
          awaitingFinish = true;
          this.once('finish', keepAlive);
        }
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
      this[kHangUp] = () => !res && !emitted;
      const deliver = (bytes) => {
        if (bytes.length === 0 || finished) return;
        if (!res.push(bytes)) socket.pause?.();
        handles?.notify?.();
      };
      const trailing = (rest) => {
        if (rest.length === 0) return;
        const next = parseHead(Buffer.from(rest), Buffer, 'response', headerLimit);
        if (!next) return;
        cut = true;
        quietClose();
        if (next.error) emitError(this, next.error);
      };
      const feed = (bytes) => {
        const f = framing;
        if (finished) return;
        if (f.kind === 'length') {
          const take = bytes.subarray(0, f.left);
          f.left -= take.length;
          deliver(take);
          if (f.left === 0) {
            finish();
            trailing(bytes.subarray(take.length));
          }
          return;
        }
        if (f.kind === 'eof') {
          deliver(bytes);
          return;
        }
        f.buf = f.buf.length ? Buffer.concat([f.buf, bytes]) : bytes;
        const chunk = f;
        const chunkError = (code, reason) => {
          const err = Object.assign(new Error(`Parse Error: ${reason}`), { code, reason });
          if (res.listenerCount('error') === 0) res.on('error', () => {});
          emitError(this, err);
          abortBody();
        };
        for (;;) {
          if (chunk.phase === 'size') {
            const line = scanChunkSize(chunk.line, chunk.buf);
            if (line.error) return chunkError(line.error.code, line.error.reason);
            if (line.need) {
              chunk.buf = Buffer.alloc(0);
              return;
            }
            chunk.buf = chunk.buf.subarray(line.used);
            if (line.size === 0n) chunk.phase = 'trailer';
            else {
              chunk.left = line.size;
              chunk.phase = 'data';
            }
          } else if (chunk.phase === 'trailer') {
            const line = readTrailer(chunk.trailer, chunk.buf, headerLimit);
            if (line.wait) {
              chunk.buf = line.rest;
              return;
            }
            if (line.error) return chunkError(line.error.code, line.error.reason);
            chunk.buf = line.rest;
            if (line.done) {
              res.rawTrailers = chunk.rawTrailers ?? [];
              res.trailers = trailerObj(res.rawTrailers);
              finish();
              trailing(chunk.buf);
              return;
            }
            if (line.header.name.toLowerCase() === 'content-length') return chunkError('HPE_INVALID_CONTENT_LENGTH', "Content-Length can't be present with Transfer-Encoding");
            (chunk.rawTrailers ??= []).push(line.header.name, line.header.value);
          } else if (chunk.phase === 'data') {
            if (chunk.buf.length === 0) return;
            const n = chunk.left > BigInt(chunk.buf.length) ? chunk.buf.length : Number(chunk.left);
            const take = chunk.buf.subarray(0, n);
            chunk.buf = chunk.buf.subarray(n);
            chunk.left -= BigInt(n);
            deliver(Buffer.from(take));
            if (chunk.left === 0n) chunk.phase = 'cr';
            else return;
          } else if (chunk.phase === 'cr') {
            if (chunk.buf.length === 0) return;
            const b = chunk.buf[0];
            if (b === 0x0a) return chunkError('HPE_CR_EXPECTED', 'Missing expected CR after chunk data');
            if (b !== 0x0d) return chunkError('HPE_STRICT', 'Expected LF after chunk data');
            chunk.buf = chunk.buf.subarray(1);
            chunk.phase = 'lf';
          } else {
            if (chunk.buf.length === 0) return;
            if (chunk.buf[0] !== 0x0a) return chunkError('HPE_STRICT', 'Expected LF after chunk data');
            chunk.buf = chunk.buf.subarray(1);
            chunk.phase = 'size';
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
        let parsed = parseHead(headBuf, Buffer, 'response', headerLimit, head);
        for (;;) {
          if (!parsed) {
            headBuf = head.rest;
            return;
          }
          head = {};
          if (parsed.error) {
            emitted = true;
            quietClose();
            emitError(this, parsed.error);
            if (!this.destroyed) this.destroy();
            return;
          }
          if (parsed.statusCode >= 100 && parsed.statusCode < 200 && parsed.statusCode !== 101) {
            if (parsed.statusCode === 100) this.emit('continue');
            headBuf = Buffer.from(parsed.bodyPrefix);
            parsed = parseHead(headBuf, Buffer, 'response', headerLimit, head);
            continue;
          }
          break;
        }
        const headers = headerObj(parsed.rawHeaders);
        emitted = true;
        // 101 Switching Protocols: Node's 'upgrade' with the response, the
        // socket (the caller's from now on) and what came after the head;
        // with no listener the connection closes.
        if (parsed.statusCode === 101 || method === 'CONNECT') {
          const event = method === 'CONNECT' ? 'connect' : 'upgrade';
          unlisten();
          this[kConnSocket] = null;
          const up = makeIncomingMessage(socket, Buffer.alloc(0));
          up.statusCode = parsed.statusCode;
          up.statusMessage = parsed.statusMessage;
          up.httpVersion = parsed.httpVersion;
          up.rawHeaders = parsed.rawHeaders;
          up.headers = headers;
          if (this.listenerCount(event) > 0) {
            socket.emit('agentRemove');
            socket.readableFlowing = null;
            this.emit(event, up, socket, Buffer.from(parsed.bodyPrefix ?? Buffer.alloc(0)));
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
          finished = true;
          if (!released && !res.readableEnded) {
            released = true;
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
          if (!this.destroyed && !awaitingFinish) this.destroy();
        });
        if (responseHasNoBody(method, parsed.statusCode)) framing = { kind: 'none' };
        else if (parsed.chunked) framing = { kind: 'chunked', buf: Buffer.alloc(0), phase: 'size', left: 0n, line: {}, trailer: { size: 0 } };
        else if (parsed.contentLength != null) framing = { kind: 'length', left: Number(parsed.contentLength) };
        else framing = { kind: 'eof' };
        // A late socket error is the body's.
        unlisten('error');
        listen('error', (err) => abortBody(err));
        res.on('end', onResponseEnd);
        if (!this.emit('response', res)) res._dump();
        if (framing.kind === 'none' || (framing.kind === 'length' && framing.left === 0)) {
          finish();
          trailing(parsed.bodyPrefix);
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
        if (awaitingFinish && !released) {
          released = true;
          this.off('finish', keepAlive);
          quietClose();
          this.destroy();
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
      this.emit('socket', socket);
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
      this[kBuffered] = 0;
      if (this[kNeedDrain] && !this.finished) {
        this[kNeedDrain] = false;
        process.nextTick(() => this.emit('drain'));
      }
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
      const headers = this[kRawHeaders] ? headerObject(this[kRawHeaders]) : this.getHeaders();
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
      if (!err && !this.aborted && !this[kFetchMode] && this[kHangUp]?.()) err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
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
      if (rawHeader(this, 'connection') == null) setRawHeader(this, 'Connection', this.shouldKeepAlive ? 'keep-alive' : 'close');
      return Buffer.from(`${method} ${path} HTTP/1.1\r\n${headerLines(this[kRawHeaders] ?? Object.values(this[kOutHeaders]))}\r\n`);
    },

    [kFlushHead]() {
      if (this._headerSent || !this[kConnSocket]) return;
      this._headerSent = true;
      let framed;
      if (this[kChunkedOut]) {
        const parts = [];
        for (const part of this[kChunks]) if (part.length) parts.push(chunkFrame(part));
        this[kChunks] = [];
        if (this[kEnded]) parts.push(Buffer.from('0\r\n\r\n'));
        framed = parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
        this[kStreaming] = true;
      } else {
        const body = Buffer.concat(this[kChunks]);
        this[kChunks] = [];
        framed = body;
        if (rawHeader(this, 'content-length') != null) {
          this[kStreaming] = true;
        } else if (!this[kEnded]) {
          this[kStreaming] = true;
          const method = (this[kOpts].method ?? 'GET').toUpperCase();
          const teRaw = rawHeader(this, 'transfer-encoding');
          const advertised = teRaw == null ? null : classifyTransferEncoding([String(teRaw)]);
          if (advertised?.chunked) {
            this[kChunkedOut] = true;
            framed = chunkFrame(body);
          } else if (!['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'].includes(method) && teRaw == null) {
            setRawHeader(this, 'Transfer-Encoding', 'chunked');
            this[kChunkedOut] = true;
            framed = chunkFrame(body);
          }
        } else {
          const method = (this[kOpts].method ?? 'GET').toUpperCase();
          const bodiless = ['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'].includes(method);
          const teRaw = rawHeader(this, 'transfer-encoding');
          if (teRaw != null) {
            if (classifyTransferEncoding([String(teRaw)])?.chunked) {
              this[kChunkedOut] = true;
              framed = Buffer.concat([chunkFrame(body), Buffer.from('0\r\n\r\n')]);
            }
          } else if (!bodiless) setRawHeader(this, 'Content-Length', String(body.length));
        }
      }
      const head = this[kRenderHead]();
      this._header = head.toString('latin1');
      this[kBuffered] = 0;
      const ok = socketWrite(this, this[kConnSocket], Buffer.concat([head, framed]), nop);
      if (ok && this[kNeedDrain] && !this.finished) {
        this[kNeedDrain] = false;
        this.emit('drain');
      }
    },

    [kWriteBody](buf, callback) {
      if (this._headerSent && this[kStreaming]) return this[kTrackWrite](this[kChunkedOut] ? chunkFrame(buf) : buf, callback);
      this[kChunks].push(buf);
      if (!this._headerSent && !this[kEnded] && !this[kFetchMode] && !this[kFetchVia]) {
        armChunked(this);
        this._header ||= this[kRenderHead]().toString('latin1');
        this[kBuffered] ??= this._header.length;
        this[kBuffered] += buf.length + (this[kChunkedOut] && buf.length ? buf.length.toString(16).length + 4 : 0);
        if (this[kBuffered] >= this[kHighWaterMark] && !this[kNeedDrain]) this[kNeedDrain] = true;
      }
      if (!this._headerSent && this[kConnected] && !this[kEnded]) this[kFlushHead]();
      process.nextTick(callback);
      return true;
    },

    [kEndBody](buf) {
      this[kEnded] = true;
      if (buf) this[kWriteBody](buf, nop);
      if (this[kFetchMode]) {
        this[kSendViaFetch]();
      } else if (!this._headerSent) {
        if (this[kConnected]) this[kFlushHead]();
        else this._header ||= this[kRenderHead]().toString('latin1');
      } else if (this[kChunkedOut]) {
        const parts = [];
        for (const part of this[kChunks]) if (part.length) parts.push(chunkFrame(part));
        this[kChunks] = [];
        parts.push(Buffer.from('0\r\n\r\n'));
        this[kTrackWrite](Buffer.concat(parts), nop);
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
  };
  Object.defineProperty(exports, 'maxHeaderSize', { configurable: true, enumerable: true, get: maxHeaderSize });
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
