/**
 * globalThis.fetch → ctx.fetch (kernel transport / proxy routes).
 *
 * As in Node, a request in flight keeps the program alive, and so does
 * reading its response's body: the request, the body methods (`text()`,
 * `json()`, …) and reads of `response.body` are tracked handles.
 */
import { trackPromise } from '../async-handles.mjs';

const BODY_METHODS = ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text'];

function trackBody(response, track) {
  for (const name of BODY_METHODS) {
    const method = response[name];
    if (typeof method !== 'function') continue;
    Object.defineProperty(response, name, {
      value: function tracked(...args) {
        return track(method.apply(response, args));
      },
      configurable: true,
      writable: true,
    });
  }
  const bodyDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(response), 'body');
  if (!bodyDesc?.get) return response;
  let wrapped;
  Object.defineProperty(response, 'body', {
    configurable: true,
    get() {
      if (wrapped !== undefined) return wrapped;
      const original = bodyDesc.get.call(response);
      if (original == null || typeof ReadableStream !== 'function') {
        wrapped = original;
        return wrapped;
      }
      let reader;
      wrapped = new ReadableStream({
        async pull(controller) {
          reader ??= original.getReader();
          const { value, done } = await track(reader.read());
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel(reason) {
          return (reader ?? original).cancel(reason);
        },
      });
      return wrapped;
    },
  });
  return response;
}

/**
 * A loopback URL's address on the kernel's own loopback, as the kernel
 * classifies names: 127.0.0.0/8, ::1, 0.0.0.0, localhost and *.localhost (a
 * trailing dot or not) at the URL's port; `<port>.kernel.localhost` (the
 * page's way to name a kernel port) at that port. `host.slicc.internal` (and
 * its address 10.0.2.2), the real machine's loopback, through the kernel's
 * proxy, which forwards it there (the platform's fetch doesn't). Else null:
 * the platform's fetch.
 */
function kernelRoute(url) {
  if (url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const port = Number(url.port || 80);
  const kernelPort = /^(\d+)\.kernel\.localhost$/.exec(host);
  if (kernelPort) return { host: '127.0.0.1', port: Number(kernelPort[1]) };
  if (host === 'localhost' || host.endsWith('.localhost')) return { host: '127.0.0.1', port };
  if (/^127(\.\d{1,3}){3}$/.test(host)) return { host, port };
  if (host === '0.0.0.0') return { host: '127.0.0.1', port };
  if (host === '[::1]' || host === '::1') return { host: '::1', port };
  if (host === 'host.slicc.internal' || host === '10.0.2.2') return KERNEL_PROXY;
  return null;
}

// The kernel's HTTP proxy (it takes absolute-form requests).
const KERNEL_PROXY = Object.freeze({ host: '127.0.0.1', port: 3128, proxy: true });

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const REDIRECT = new Set([301, 302, 303, 307, 308]);
// What undici adds to a request that doesn't set them, in its order.
const DEFAULT_HEADERS = [
  ['accept', '*/*'],
  ['accept-language', '*'],
  ['sec-fetch-mode', 'cors'],
  ['user-agent', 'node'],
  ['accept-encoding', 'gzip, deflate'],
];

// The fetch spec's bad ports (undici's badPorts): an http(s) request to one
// is a network error, 'bad port'.
const BAD_PORTS = new Set([
  '1', '7', '9', '11', '13', '15', '17', '19', '20', '21', '22', '23', '25', '37', '42', '43', '53', '69', '77', '79',
  '87', '95', '101', '102', '103', '104', '109', '110', '111', '113', '115', '117', '119', '123', '135', '137',
  '139', '143', '161', '179', '389', '427', '465', '512', '513', '514', '515', '526', '530', '531', '532',
  '540', '548', '554', '556', '563', '587', '601', '636', '989', '990', '993', '995', '1719', '1720', '1723',
  '2049', '3659', '4045', '4190', '5060', '5061', '6000', '6566', '6665', '6666', '6667', '6668', '6669', '6679',
  '6697', '10080',
]);
const isBadPort = (url) => (url.protocol === 'http:' || url.protocol === 'https:') && BAD_PORTS.has(url.port);

/** undici's TypeError('fetch failed') with the network error as its cause. */
const fetchFailed = (cause) => Object.assign(new TypeError('fetch failed'), { cause });

/**
 * fetch to the kernel's loopback: an HTTP/1.1 request over the kernel's
 * sockets (node:http's client, as http.get reaches a server of this kernel),
 * answered as undici's fetch answers: redirects followed (or manual / error),
 * gzip and deflate bodies decoded, AbortSignal, `fetch failed` errors.
 */
async function loopbackFetch(getHttp, request, target, initHeaders) {
  const http = getHttp();
  const signal = request.signal;
  if (signal?.aborted) throw signal.reason;
  let method = request.method;
  let body = method === 'GET' || method === 'HEAD' ? null : new Uint8Array(await request.arrayBuffer());
  // undici keeps the order headers were given in (a Headers object's own
  // order is sorted); the Request has them all (its own content-type too).
  const headers = [];
  const given = Array.isArray(initHeaders)
    ? initHeaders.map(([k]) => String(k).toLowerCase())
    : initHeaders && typeof initHeaders === 'object' && !(initHeaders instanceof Headers)
      ? Object.keys(initHeaders).map((k) => k.toLowerCase())
      : [];
  for (const k of new Set(given)) if (request.headers.has(k)) headers.push([k, request.headers.get(k)]);
  for (const [k, v] of request.headers) if (!given.includes(k)) headers.push([k, v]);
  for (const [k, v] of DEFAULT_HEADERS) if (!request.headers.has(k)) headers.push([k, v]);
  let url = new URL(request.url);
  let addr = target;
  let redirected = false;
  for (let hops = 0; ; hops++) {
    const res = await new Promise((resolve, reject) => {
      const outgoing = {};
      for (const [k, v] of headers) outgoing[k] = v;
      const req = http.request({
        host: addr.host,
        port: addr.port,
        method,
        path: addr.proxy ? `${url.origin}${url.pathname}${url.search}` : `${url.pathname}${url.search}`,
        headers: { host: url.host, ...outgoing },
      });
      const onAbort = () => {
        req.destroy();
        reject(signal.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('response', (incoming) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(incoming);
      });
      req.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(signal?.aborted ? signal.reason : fetchFailed(err));
      });
      req.end(body ?? undefined);
    });
    const status = res.statusCode;
    const location = res.headers.location;
    if (REDIRECT.has(status) && location !== undefined && request.redirect !== 'manual') {
      res.resume();
      if (request.redirect === 'error') throw fetchFailed(new TypeError('unexpected redirect'));
      if (hops >= 20) throw fetchFailed(new TypeError('redirect count exceeded'));
      const from = url;
      url = new URL(location, url);
      redirected = true;
      // Another origin gets no credentials (undici, after the fetch spec).
      if (url.origin !== from.origin) {
        for (let i = headers.length - 1; i >= 0; i--) {
          if (/^(authorization|proxy-authorization|cookie|host)$/.test(headers[i][0])) headers.splice(i, 1);
        }
      }
      // 303, and 301/302 from a POST: a GET without the body (the fetch spec).
      if (status === 303 ? method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST') {
        method = 'GET';
        body = null;
        for (let i = headers.length - 1; i >= 0; i--) {
          if (/^content-(type|length|encoding|language|location)$/.test(headers[i][0])) headers.splice(i, 1);
        }
      }
      if (isBadPort(url)) throw fetchFailed(new Error('bad port'));
      const next = kernelRoute(url);
      if (!next) {
        // Off the loopback: the platform's fetch takes it from here.
        return { handoff: new Request(url, { method, headers, body, redirect: request.redirect, signal }) };
      }
      addr = next;
      continue;
    }
    return { response: toResponse(res, { method, signal }, url, redirected) };
  }
}

function toResponse(res, { method, signal }, url, redirected) {
  const headers = new Headers();
  for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
  let stream = null;
  if (!NULL_BODY.has(res.statusCode) && method !== 'HEAD') {
    let onAbort;
    let settled = false;
    const done = () => {
      settled = true;
      signal?.removeEventListener('abort', onAbort);
    };
    stream = new ReadableStream({
      start(controller) {
        // An abort while the body is read ends it with the signal's reason.
        onAbort = () => {
          if (settled) return;
          done();
          res.destroy();
          controller.error(signal.reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        res.on('data', (chunk) => {
          if (!settled) controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        });
        res.on('end', () => {
          if (settled) return;
          done();
          controller.close();
        });
        res.on('error', (err) => {
          if (settled) return;
          done();
          controller.error(fetchFailed(err));
        });
      },
      cancel() {
        done();
        res.destroy();
      },
    });
    // undici decodes what it asked for (gzip, deflate).
    const coding = String(headers.get('content-encoding') ?? '').toLowerCase().trim();
    if ((coding === 'gzip' || coding === 'x-gzip' || coding === 'deflate') && typeof DecompressionStream === 'function') {
      stream = stream.pipeThrough(new DecompressionStream(coding === 'deflate' ? 'deflate' : 'gzip'));
    }
  }
  const response = new Response(stream, { status: res.statusCode, statusText: res.statusMessage ?? '', headers });
  Object.defineProperty(response, 'url', { value: url.href, configurable: true });
  Object.defineProperty(response, 'redirected', { value: redirected, configurable: true });
  return response;
}

export function createFetch(ctx, { handles, getHttp } = {}) {
  const track = (p) => (handles ? trackPromise(handles, p) : p);
  async function fetch(input, init) {
    if (typeof ctx.fetch !== 'function') {
      const err = new TypeError('fetch failed');
      err.cause = Object.assign(new Error("slicc-jsh: ctx.fetch is not available"), {
        code: 'ENOTSUP',
      });
      throw err;
    }
    // A server of this kernel: its own sockets (the platform's fetch would
    // go to the host's loopback, or nowhere in a browser).
    let request;
    let target = null;
    try {
      request = new Request(input, init);
    } catch {
      request = undefined;
    }
    if (request) {
      const url = new URL(request.url);
      if (isBadPort(url)) throw fetchFailed(new Error('bad port'));
      if (getHttp) target = kernelRoute(url);
    }
    if (target) {
      const result = await track(loopbackFetch(getHttp, request, target, init?.headers));
      if (result.response) return handles ? trackBody(result.response, track) : result.response;
      input = result.handoff;
      init = undefined;
    }
    const response = await track(ctx.fetch(input, init));
    if (!handles || response == null || typeof response !== 'object') return response;
    try {
      return trackBody(response, track);
    } catch {
      return response;
    }
  }
  return fetch;
}
