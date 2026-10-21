/**
 * node:https — createServer awaits kernel TLS; client request/get go through
 * the fetch client http shares (http-fetch.mjs): redirect: 'manual' where the
 * transport can, the response body streamed. A request with its own agent
 * or createConnection (a proxy agent's, ws's wss://) goes over a socket
 * instead, http's ClientRequest on tls.connect, where the kernel has TLS
 * (slicc-kernel 1.116.0).
 */
import { trackPromise } from '../async-handles.mjs';
import { EventEmitter } from './events.mjs';
import { connectError, createFetchClient, isLoopbackHost } from './http-fetch.mjs';
import { noTls as notSupported } from './tls.mjs';
import { kernelAtLeast } from '../kernel-version.mjs';
import { queueMicrotask } from '../async-context.mjs';

const TLS_CLIENT_OPTS = ['cert', 'key', 'pfx', 'ca'];

// From slicc-kernel 1.124.0 the kernel's own handshake takes a `ca`
// (ai-ecoverse/slicc-kernel#922), and from 1.124.13 a client certificate
// (ai-ecoverse/slicc-kernel#1004): a request with one goes over a TLS socket.
// `pfx` it doesn't take.
function rejectTlsOptions(options, kernelTls = false, kernelCerts = false) {
  for (const name of TLS_CLIENT_OPTS) {
    if (options?.[name] != null && !(kernelTls && name === 'ca') && !(kernelCerts && (name === 'cert' || name === 'key'))) {
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

export function createHttps({ ctx, Buffer, http, handles, getStream, timers = globalThis, getTls }) {
  const { setTimeout, clearTimeout } = timers;
  const client = createFetchClient({ ctx, Buffer, handles, STATUS_CODES: http?.STATUS_CODES, IncomingMessage: http?.IncomingMessage });

  function createServer() {
    throw notSupported('https.createServer');
  }

  function Server(options, requestListener) {
    void options;
    void requestListener;
    throw notSupported('https.Server');
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
      // Node's: what the request is, readable as res.req's.
      // The options as merged over the URL: an overriding path or hostname wins.
      this.method = String(options?.method ?? 'GET').toUpperCase();
      this.path = options?.path ?? '/';
      this.host = String(options?.hostname ?? options?.host ?? 'localhost').replace(/^\[|\]$/g, '');
      this.protocol = 'https:';
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
        // The options as merged over the URL (an overriding path, hostname
        // or port wins, as in Node).
        const host = String(opts.hostname ?? opts.host ?? 'localhost').replace(/^\[|\]$/g, '');
        const port = opts.port ?? 443;
        const path = opts.path ?? '/';
        // The kernel's loopback has no TLS (a fetch there is refused, or on
        // older kernels the transport answers 403): connect first, so a
        // port nothing listens on is ECONNREFUSED, as Node's.
        if (isLoopbackHost(host) && typeof ctx.net?.connect === 'function') {
          let conn;
          try {
            conn = await ctx.net.connect({ host: /localhost\.?$/i.test(host) ? '127.0.0.1' : host, port: Number(port) });
          } catch (err) {
            throw connectError(err?.code ?? err?.cause?.code ?? 'ECONNREFUSED', host, port, err);
          }
          void conn.close?.();
          throw notSupported("https to the kernel's own loopback (it has no TLS)");
        }
        const incoming = await client.send({
          protocol: 'https:',
          host,
          port,
          path,
          method,
          headers: this.#headers,
          body: this.#body.length ? Buffer.concat(this.#body) : undefined,
          signal: this.#abort.signal,
          req: this,
        });
        if (this.#destroyed) {
          incoming.destroy();
          return;
        }
        this.res = incoming;
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
        hostname: url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
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

  // Over a socket: a request with its own agent or createConnection, on a
  // kernel whose ctx.net.connect carries TLS. Its default agent is https's.
  // On slicc-kernel 1.124.0 and later, also a request with a `ca`, which
  // fetch can't take (the kernel's handshake, for a host the uplink routes).
  // On 1.124.13 and later, a client certificate likewise.
  const kernelTls = kernelAtLeast(ctx, '1.124.0');
  const kernelCerts = kernelAtLeast(ctx, '1.124.13');
  const viaSocket = (options) =>
    kernelAtLeast(ctx, '1.116.0') &&
    typeof http?.request === 'function' &&
    (typeof options?.createConnection === 'function' ||
      (options?.agent != null && options.agent !== false && options.agent !== globalAgent) ||
      (kernelTls && (options?.ca != null || options?.secureContext != null)) ||
      (kernelCerts && (options?.cert != null || options?.key != null)));

  function request(input, options, callback) {
    const norm = normalize(input, options, callback);
    if (viaSocket(norm.options)) {
      rejectTlsOptions(norm.options, kernelTls, kernelCerts);
      // Node's agent calls tls.connect inside https.request, so key material
      // that isn't (ERR_OSSL_*) throws from it; jsh's agent connects later.
      // Only https's own connection parses it: a createConnection of the
      // caller's (or an agent's own) gets cert and key as given, as in Node.
      const { cert, key, secureContext, createConnection, agent } = norm.options;
      const used = agent === false || agent == null ? globalAgent : agent;
      const ownTls =
        typeof createConnection !== 'function' && used instanceof Agent && used.createConnection === Agent.prototype.createConnection;
      if (kernelCerts && ownTls && (cert != null || key != null) && secureContext == null) getTls().createSecureContext(norm.options);
      // Node's agent: false is a fresh agent of the default's kind (not a plain socket).
      const own = norm.options.agent === false && typeof norm.options.createConnection !== 'function' ? { agent: new Agent() } : {};
      return http.request(
        { _defaultAgent: globalAgent, defaultPort: 443, port: 443, ...norm.options, ...own, protocol: 'https:' },
        norm.callback
      );
    }
    return new ClientRequest(norm.options, norm.callback);
  }

  function get(input, options, callback) {
    const req = request(input, options, callback);
    req.end();
    return req;
  }

  // Node's https.Agent: http's, with TLS sockets (tls.connect), port 443 and
  // the TLS options in its socket names. Unit stubs may omit http.Agent.
  const BaseAgent = typeof http?.Agent === 'function' ? http.Agent : class Agent extends EventEmitter {};
  class Agent extends BaseAgent {
    constructor(options) {
      super({ ...options });
      this.defaultPort = 443;
      this.protocol = 'https:';
    }
    createConnection(options, callback) {
      const socket = getTls().connect(options);
      if (typeof callback === 'function') socket.once('secureConnect', () => callback(null, socket));
      return socket;
    }
    getName(options = {}) {
      let name = typeof super.getName === 'function' ? super.getName(options) : '';
      for (const key of ['ca', 'cert', 'clientCertEngine', 'ciphers', 'key', 'pfx']) {
        name += ':';
        if (options[key]) name += options[key];
      }
      name += ':';
      if (options.rejectUnauthorized !== undefined) name += options.rejectUnauthorized;
      name += ':';
      if (options.servername && options.servername !== options.host) name += options.servername;
      for (const key of ['minVersion', 'maxVersion', 'secureProtocol', 'crl']) {
        name += ':';
        if (options[key]) name += options[key];
      }
      name += ':';
      if (options.honorCipherOrder !== undefined) name += options.honorCipherOrder;
      for (const key of ['ecdhCurve', 'dhparam']) {
        name += ':';
        if (options[key]) name += options[key];
      }
      name += ':';
      if (options.secureOptions !== undefined) name += options.secureOptions;
      name += ':';
      if (options.sessionIdContext) name += options.sessionIdContext;
      name += ':';
      if (options.sigalgs) name += JSON.stringify(options.sigalgs);
      for (const key of ['privateKeyIdentifier', 'privateKeyEngine']) {
        name += ':';
        if (options[key]) name += options[key];
      }
      return name;
    }
  }
  const globalAgent = new Agent({ keepAlive: true, scheduling: 'lifo', timeout: 5000 });
  return {
    ...http,
    Agent,
    globalAgent,
    Server,
    createServer,
    request,
    get,
  };
}
