/**
 * The fetch-backed HTTP client that https.request uses always, and
 * http.request when the kernel has no route for a host (no uplink, or an
 * address outside its route table): one ctx.fetch per request, the response
 * streamed into an IncomingMessage-like Readable.
 *
 * What a fetch can't do, it doesn't: there is no raw socket (res.socket and
 * req.socket are null), no Agent pooling or keep-alive, no upgrade or
 * CONNECT, no 1xx / Expect: 100-continue and no trailers; header names come
 * back lowercased and the hop-by-hop and forbidden ones (Host, Connection,
 * Content-Length, …) are fetch's to set; the request body is sent once it
 * has ended; a browser transport can't do redirect: 'manual', so redirects
 * are followed there.
 */
import { trackPromise } from '../async-handles.mjs';
import { UV_ERRORS } from '../node-bindings.mjs';

const ERRNO = Object.fromEntries(UV_ERRORS.map(([n, name]) => [name, n]));

/** Headers fetch sets itself, or refuses (the Fetch standard's forbidden request headers). */
const FETCH_OWNED = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'expect',
  'upgrade',
  'te',
  'trailer',
  'proxy-connection',
]);

/** Methods the Fetch standard forbids (a Request with one throws). */
const FETCH_FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);

function unsupported(what, host) {
  const e = new Error(`slicc-jsh: ${what} can't go through fetch (no route to ${host} in the kernel)`);
  e.code = 'ERR_NOT_SUPPORTED';
  return e;
}

const isIp = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || String(host).includes(':');

/** Loopback as the kernel sees it: always its own, never routed. */
export function isLoopbackHost(host) {
  const h = String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  return (
    h === '' ||
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    /^127\./.test(h) ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h === '::'
  );
}

/**
 * Node's error for a connection that failed: `getaddrinfo ENOTFOUND <name>`
 * for a name that resolves to nothing (the kernel's ENOENT; with
 * `noNetwork`, a fetch's ENETUNREACH for a name), else
 * `connect <CODE> <host>:<port>`.
 */
export function connectError(code, host, port, cause, { noNetwork = false } = {}) {
  const name = String(host ?? '');
  // With no network at all (fetch's ENETUNREACH), a name is one nothing resolves.
  const unresolved = code === 'ENOENT' || code === 'EAI_NONAME' || code === 'ENOTFOUND' || (noNetwork && code === 'ENETUNREACH');
  let e;
  if (unresolved && !isIp(name)) {
    e = new Error(`getaddrinfo ENOTFOUND ${name}`);
    e.errno = ERRNO.EAI_NONAME;
    e.code = 'ENOTFOUND';
    e.syscall = 'getaddrinfo';
    e.hostname = name;
  } else {
    const c = typeof code === 'string' && code ? code : 'EIO';
    // A loopback name is the kernel's 127.0.0.1 (IPv4 only), as getaddrinfo answers it.
    const address = /^(localhost|.*\.localhost)\.?$/i.test(name) ? '127.0.0.1' : name;
    e = new Error(`connect ${c} ${address}:${port}`);
    e.errno = ERRNO[c] ?? c;
    e.code = c;
    e.syscall = 'connect';
    e.address = address;
    e.port = Number(port);
  }
  if (cause !== undefined) Object.defineProperty(e, 'cause', { value: cause, configurable: true, writable: true });
  return e;
}

function isManualRedirectUnsupported(err) {
  const code = err?.cause?.code ?? err?.code;
  if (code === 'ENOTSUP') return true;
  const msg = String(err?.cause?.message ?? err?.message ?? '');
  return /redirect:\s*manual/i.test(msg);
}

/**
 * `getFetch`: the fetch to use, ctx.fetch by default. http passes jsh's own
 * (web/fetch.mjs), which reaches the real machine's loopback
 * (host.slicc.internal) through the kernel's proxy as `fetch()` does.
 */
export function createFetchClient({ ctx, Buffer, getStream, handles, STATUS_CODES = {}, getFetch }) {
  const doFetch = (url, init) => (getFetch?.() ?? ctx.fetch)(url, init);
  // The kernel rejects redirect: 'manual' with ENOTSUP before it sends when
  // the transport can't do it (a browser's fetchTransport): then follow,
  // and remember that for the process.
  let manualRedirects = true;

  async function fetchManual(url, init) {
    if (!manualRedirects) return doFetch(url, { ...init, redirect: 'follow' });
    try {
      return await doFetch(url, { ...init, redirect: 'manual' });
    } catch (err) {
      if (!isManualRedirectUnsupported(err)) throw err;
      manualRedirects = false;
      return doFetch(url, { ...init, redirect: 'follow' });
    }
  }

  /** The request's headers as fetch takes them (the ones fetch owns left out). */
  function fetchHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers ?? {})) {
      if (v == null || FETCH_OWNED.has(String(k).toLowerCase())) continue;
      out[k] = Array.isArray(v) ? v.map(String).join(', ') : String(v);
    }
    return out;
  }

  /** An IncomingMessage-like Readable over a fetch Response, its body streamed. */
  function incomingFrom(res, method, req) {
    const { Readable } = getStream();
    let reader = null;
    let done = false;
    const msg = new Readable({
      async read() {
        if (done) return;
        try {
          reader ??= res.body?.getReader?.() ?? null;
          if (!reader) {
            done = true;
            msg.complete = true;
            msg.push(null);
            return;
          }
          // A pending read keeps the program alive, as Node's open socket does.
          const pending = reader.read();
          const { value, done: end } = await (handles ? trackPromise(handles, pending) : pending);
          if (end) {
            done = true;
            msg.complete = true;
            msg.push(null);
          } else msg.push(Buffer.from(value));
        } catch (err) {
          done = true;
          msg.emit('aborted');
          msg.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET', cause: err }));
        } finally {
          handles?.notify?.();
        }
      },
      destroy(err, cb) {
        if (!done) {
          done = true;
          (reader ?? res.body)?.cancel?.().catch?.(() => {});
        }
        cb(err);
      },
    });
    msg.socket = null;
    msg.connection = null;
    msg.httpVersion = '1.1';
    msg.httpVersionMajor = 1;
    msg.httpVersionMinor = 1;
    msg.statusCode = res.status;
    msg.statusMessage = res.statusText || STATUS_CODES[res.status] || '';
    msg.headers = Object.create(null);
    msg.rawHeaders = [];
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : null;
    res.headers.forEach((value, key) => {
      const k = String(key).toLowerCase();
      if (k === 'set-cookie' && cookies) return;
      msg.headers[k] = value;
      msg.rawHeaders.push(key, value);
    });
    if (cookies?.length) {
      msg.headers['set-cookie'] = cookies;
      for (const c of cookies) msg.rawHeaders.push('set-cookie', c);
    }
    msg.trailers = {};
    msg.rawTrailers = [];
    msg.method = undefined;
    msg.url = undefined;
    msg.complete = false;
    msg.req = req;
    msg.setTimeout = () => msg;
    if (method === 'HEAD' || [204, 304].includes(res.status) || (res.status >= 100 && res.status < 200)) {
      done = true;
      res.body?.cancel?.().catch?.(() => {});
      msg.complete = true;
      msg.push(null);
    }
    return msg;
  }

  /**
   * One request: resolves with the IncomingMessage, or rejects with a
   * Node-shaped error (getaddrinfo ENOTFOUND, connect ECONNREFUSED, …);
   * an abort rejects with the signal's reason.
   */
  async function send({ protocol, host, port, path, method, headers, body, signal, req }) {
    const m0 = String(method || 'GET').toUpperCase();
    // What fetch can't send, refused before anything goes out rather than
    // sent as another request: the methods it forbids, and a GET / HEAD body.
    if (FETCH_FORBIDDEN_METHODS.has(m0)) throw unsupported(`a ${m0} request`, host);
    if ((m0 === 'GET' || m0 === 'HEAD') && body?.length) throw unsupported(`a ${m0} request with a body`, host);
    const defaultPort = protocol === 'https:' ? 443 : 80;
    const h = String(host).includes(':') && !String(host).startsWith('[') ? `[${host}]` : host;
    const url = `${protocol}//${h}${Number(port) === defaultPort ? '' : `:${port}`}${path || '/'}`;
    const m = m0;
    let res;
    try {
      res = await fetchManual(url, {
        method: m,
        headers: fetchHeaders(headers),
        body: m === 'GET' || m === 'HEAD' ? undefined : body?.length ? body : undefined,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      const code = err?.cause?.code ?? err?.code;
      // A failure with no errno (a header fetch refuses, …) is fetch's own.
      if (typeof code !== 'string') throw err;
      throw connectError(code, host, port, err, { noNetwork: true });
    }
    return incomingFrom(res, m, req);
  }

  return { send, fetchHeaders };
}
