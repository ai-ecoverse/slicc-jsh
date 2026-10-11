/**
 * node:https — createServer awaits kernel TLS; client request/get use ctx.fetch.
 */
import { EventEmitter } from './events.mjs';

function notSupported(what) {
  const err = new Error(`slicc-jsh: '${what}' is not supported yet (no TLS on ctx.net)`);
  err.code = 'ERR_NOT_SUPPORTED';
  return err;
}

export function createHttps({ ctx, Buffer, http }) {
  function createServer() {
    throw notSupported('https.createServer');
  }

  class ClientRequest extends EventEmitter {
    #ended = false;
    #body = [];
    #opts;
    #callback;

    constructor(options, callback) {
      super();
      this.#opts = options;
      this.#callback = callback;
      if (callback) this.once('response', callback);
      queueMicrotask(() => {
        if (this.#ended) void this.#send();
      });
    }

    setHeader() {
      return this;
    }
    getHeader() {
      return undefined;
    }
    removeHeader() {
      return this;
    }
    setTimeout() {
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
      void this.#send().then(() => this.emit('finish'));
      return this;
    }
    abort() {
      this.emit('abort');
    }
    destroy(err) {
      if (err) this.emit('error', err);
    }

    async #send() {
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
        const res = await ctx.fetch(url, {
          method,
          headers: opts.headers,
          body,
        });
        const incoming = new http.IncomingMessage(null);
        incoming.statusCode = res.status;
        incoming.statusMessage = res.statusText;
        incoming.headers = Object.create(null);
        incoming.rawHeaders = [];
        res.headers.forEach((value, key) => {
          incoming.headers[key] = value;
          incoming.rawHeaders.push(key, value);
        });
        const ab = await res.arrayBuffer();
        const buf = Buffer.from(ab);
        queueMicrotask(() => {
          this.emit('response', incoming);
          if (buf.length) incoming.push(buf);
          incoming.complete = true;
          incoming.push(null);
        });
      } catch (err) {
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

  return {
    ...http,
    globalAgent: new (class Agent extends EventEmitter {})(),
    Agent: class Agent extends EventEmitter {},
    createServer,
    request,
    get,
  };
}
