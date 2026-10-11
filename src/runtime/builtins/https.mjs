/**
 * node:https — createServer awaits kernel TLS; client request/get use ctx.fetch.
 * Prefer redirect: 'manual' (Node-like). On transports that reject it (browser
 * fetchTransport → ENOTSUP), fall back to 'follow' so plain GETs still work.
 */
import { trackPromise } from '../async-handles.mjs';
import { EventEmitter } from './events.mjs';

const TLS_CLIENT_OPTS = ['cert', 'key', 'pfx', 'ca'];

function notSupported(what) {
  const err = new Error(`slicc-jsh: '${what}' is not supported yet (no TLS on ctx.net)`);
  err.code = 'ERR_NOT_SUPPORTED';
  return err;
}

function isManualRedirectUnsupported(err) {
  const code = err?.cause?.code ?? err?.code;
  if (code === 'ENOTSUP') return true;
  const msg = String(err?.cause?.message ?? err?.message ?? '');
  return /redirect:\s*manual/i.test(msg);
}

function rejectTlsOptions(options) {
  for (const name of TLS_CLIENT_OPTS) {
    if (options?.[name] != null) {
      throw notSupported(`https.request option '${name}'`);
    }
  }
}

function headersToObject(headers) {
  const out = Object.create(null);
  if (!headers) return out;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value);
    });
    return out;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    out[String(k).toLowerCase()] = Array.isArray(v) ? v.map(String).join(', ') : String(v);
  }
  return out;
}

export function createHttps({ ctx, Buffer, http, handles }) {
  // Kernel rejects redirect:'manual' with ENOTSUP before send() when the
  // transport lacks traits.manualRedirects (browser fetchTransport). Remember
  // per process so we do not probe twice on every request.
  let manualRedirects = true;

  /** ctx.fetch with redirect:manual, falling back to follow when unsupported. */
  async function fetchHttp(url, init) {
    if (!manualRedirects) {
      return ctx.fetch(url, { ...init, redirect: 'follow' });
    }
    try {
      return await ctx.fetch(url, { ...init, redirect: 'manual' });
    } catch (err) {
      if (!isManualRedirectUnsupported(err)) throw err;
      manualRedirects = false;
      return ctx.fetch(url, { ...init, redirect: 'follow' });
    }
  }

  function createServer() {
    throw notSupported('https.createServer');
  }

  class ClientRequest extends EventEmitter {
    #ended = false;
    #sent = false;
    #body = [];
    #opts;
    #headers = Object.create(null);
    #abort = new AbortController();
    #timeout = null;
    #destroyed = false;

    constructor(options, callback) {
      super();
      rejectTlsOptions(options);
      this.#opts = options;
      this.#headers = headersToObject(options?.headers);
      if (callback) this.once('response', callback);
    }

    setHeader(name, value) {
      this.#headers[String(name).toLowerCase()] = Array.isArray(value)
        ? value.map(String).join(', ')
        : String(value);
      return this;
    }
    getHeader(name) {
      return this.#headers[String(name).toLowerCase()];
    }
    removeHeader(name) {
      delete this.#headers[String(name).toLowerCase()];
      return this;
    }
    setTimeout(ms, cb) {
      if (this.#timeout) clearTimeout(this.#timeout);
      if (ms > 0) {
        this.#timeout = setTimeout(() => {
          this.#timeout = null;
          this.emit('timeout');
          if (typeof cb === 'function') cb();
        }, ms);
        this.#timeout.unref?.();
      }
      return this;
    }
    write(chunk, encoding, cb) {
      if (chunk != null && chunk !== '') {
        this.#body.push(
          typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk)
        );
      }
      if (typeof encoding === 'function') encoding();
      else if (typeof cb === 'function') cb();
      return true;
    }
    end(chunk, encoding, cb) {
      if (typeof chunk === 'function') {
        cb = chunk;
        chunk = undefined;
      } else if (typeof encoding === 'function') {
        cb = encoding;
        encoding = undefined;
      }
      if (chunk != null && chunk !== '') this.write(chunk, encoding);
      this.#ended = true;
      if (typeof cb === 'function') this.once('finish', cb);
      // Keep the jsh event loop alive until ctx.fetch settles (libuv-request style).
      const pending = this.#send().then(() => {
        if (!this.#destroyed) this.emit('finish');
      });
      if (handles) void trackPromise(handles, pending);
      else void pending;
      return this;
    }
    abort() {
      this.destroy();
    }
    destroy(err) {
      if (this.#destroyed) return this;
      this.#destroyed = true;
      if (this.#timeout) {
        clearTimeout(this.#timeout);
        this.#timeout = null;
      }
      try {
        this.#abort.abort(err ?? new Error('aborted'));
      } catch {
        /* ignore */
      }
      if (err) this.emit('error', err);
      this.emit('close');
      return this;
    }

    async #send() {
      if (this.#sent || this.#destroyed) return;
      this.#sent = true;
      try {
        if (typeof ctx.fetch !== 'function') throw notSupported('https.request');
        const opts = this.#opts;
        const method = (opts.method ?? 'GET').toUpperCase();
        const host = opts.hostname ?? opts.host ?? 'localhost';
        const port = opts.port ? `:${opts.port}` : '';
        const path = opts.path ?? '/';
        const url = opts.href ?? `https://${host}${port}${path}`;
        const body =
          method === 'GET' || method === 'HEAD'
            ? undefined
            : this.#body.length
              ? Buffer.concat(this.#body)
              : undefined;
        const res = await fetchHttp(url, {
          method,
          headers: this.#headers,
          body,
          signal: this.#abort.signal,
        });
        if (this.#destroyed) return;
        const ab = method === 'HEAD' ? new ArrayBuffer(0) : await res.arrayBuffer();
        if (this.#destroyed) return;
        const buf = Buffer.from(ab);
        const incoming = http.IncomingMessage(null, buf);
        incoming.statusCode = res.status;
        incoming.statusMessage = res.statusText;
        incoming.headers = Object.create(null);
        incoming.rawHeaders = [];
        res.headers.forEach((value, key) => {
          incoming.headers[String(key).toLowerCase()] = value;
          incoming.rawHeaders.push(key, value);
        });
        queueMicrotask(() => {
          if (this.#destroyed) return;
          this.emit('response', incoming);
        });
      } catch (err) {
        if (this.#destroyed || this.#abort.signal.aborted) {
          if (!this.#destroyed) this.destroy();
          return;
        }
        this.emit('error', err);
      }
    }
  }

  function normalize(input, options, callback) {
    if (typeof input === 'string' || input instanceof URL) {
      const url = new URL(input);
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      options = {
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        href: url.href,
        method: options?.method,
        headers: options?.headers,
        ...options,
      };
    } else if (typeof input === 'object' && input !== null) {
      if (typeof options === 'function') {
        callback = options;
        options = input;
      } else options = input;
      options = { protocol: 'https:', ...options };
    }
    return { options: options ?? { protocol: 'https:' }, callback };
  }

  function request(input, options, callback) {
    const norm = normalize(input, options, callback);
    return new ClientRequest(norm.options, norm.callback);
  }

  function get(input, options, callback) {
    const req = request(input, options, callback);
    req.end();
    return req;
  }

  // Reuse http.Agent when present; unit stubs may omit it.
  const Agent =
    typeof http?.Agent === 'function'
      ? http.Agent
      : class Agent extends EventEmitter {};
  return {
    ...http,
    Agent,
    globalAgent: new Agent({ protocol: 'https:' }),
    createServer,
    request,
    get,
  };
}
