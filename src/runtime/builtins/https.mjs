/**
 * node:https — servers on tls.Server's kernel TLS; client request/get go through
 * the fetch client http shares (http-fetch.mjs): redirect: 'manual' where the
 * transport can, the response body streamed. A request with its own agent
 * or createConnection (a proxy agent's, ws's wss://) goes over a socket
 * instead, http's ClientRequest on tls.connect.
 */
import { EventEmitter } from './events.mjs';
import { createFetchClient, isLoopbackHost } from './http-fetch.mjs';
import { httpInternals, kFetchVia } from './http.mjs';
import { noTls as notSupported } from './tls.mjs';
import { validateObject } from '../node-errors.mjs';

const TLS_CLIENT_OPTS = ['cert', 'key', 'pfx', 'ca'];

// The kernel's own handshake takes a `ca` and a client certificate: a
// request with one goes over a TLS socket. `pfx` it doesn't take.
function rejectTlsOptions(options, overSocket = false) {
  for (const name of TLS_CLIENT_OPTS) {
    if (options?.[name] != null && !(overSocket && name !== 'pfx')) {
      throw notSupported(`https.request option '${name}'`);
    }
  }
}

export function createHttps({ ctx, Buffer, http, handles, getTls }) {
  const client = createFetchClient({ ctx, Buffer, handles, STATUS_CODES: http?.STATUS_CODES, IncomingMessage: http?.IncomingMessage });

  const tls = getTls();
  const { storeHttpOptions, handleConnection, setupConnectionsTracking, stopConnectionsChecking } = httpInternals.get(http);

  function Server(options, requestListener) {
    if (!new.target) return new Server(options, requestListener);
    if (typeof options === 'function') {
      requestListener = options;
      options = {};
    } else if (options == null) {
      options = {};
    } else {
      validateObject(options, 'options');
    }
    const httpOptions = {};
    storeHttpOptions(httpOptions, options);
    const alpn = options.ALPNProtocols || options.ALPNCallback ? {} : { ALPNProtocols: ['http/1.1'] };
    const self = Reflect.construct(tls.Server, [{ noDelay: true, ...alpn, ...options }], new.target);
    Object.assign(self, httpOptions);
    self.httpAllowHalfOpen = false;
    self.on('secureConnection', (socket) => handleConnection(socket, undefined, self));
    if (requestListener) self.on('request', requestListener);
    self.on('tlsClientError', function onTlsClientError(err, conn) {
      if (!this.emit('clientError', err, conn)) conn.destroy(err);
    });
    self.on('listening', setupConnectionsTracking);
    self.on('listening', () => {
      self._closing = false;
    });
    return self;
  }
  Object.setPrototypeOf(Server.prototype, tls.Server.prototype);
  Object.setPrototypeOf(Server, tls.Server);
  Server.prototype.closeAllConnections = http.Server.prototype.closeAllConnections;
  Server.prototype.closeIdleConnections = http.Server.prototype.closeIdleConnections;
  Server.prototype.setTimeout = http.Server.prototype.setTimeout;
  Server.prototype.close = function close(...args) {
    this.closeIdleConnections();
    stopConnectionsChecking(this);
    return tls.Server.prototype.close.apply(this, args);
  };
  Server.prototype[Symbol.asyncDispose ?? Symbol.for('nodejs.asyncDispose')] = async function asyncDispose() {
    return new Promise((resolve, reject) => this.close((err) => (err ? reject(err) : resolve())));
  };

  function createServer(options, requestListener) {
    return new Server(options, requestListener);
  }

  async function send({ host, port, path, method, headers, body, signal, req }) {
    if (typeof ctx.fetch !== 'function') throw notSupported('https.request');
    host = String(host ?? 'localhost').replace(/^\[|\]$/g, '');
    return client.send({ protocol: 'https:', host, port, path, method, headers, body, signal, req });
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

  // Over a socket: a request with its own agent or createConnection, or with
  // a `ca`, a secureContext or a client certificate, which fetch can't take
  // (the kernel's handshake, for a host the uplink routes), or to the
  // kernel's own loopback, whose servers fetch can't reach. Its default
  // agent is https's.
  const viaSocket = (options) =>
    typeof http?.request === 'function' &&
    (typeof options?.createConnection === 'function' ||
      (options?.agent != null && options.agent !== false && options.agent !== globalAgent) ||
      options?.ca != null ||
      options?.secureContext != null ||
      options?.cert != null ||
      options?.key != null ||
      (typeof ctx.net?.secure === 'function' && isLoopbackHost(options?.hostname ?? options?.host)));

  function request(input, options, callback) {
    const norm = normalize(input, options, callback);
    if (viaSocket(norm.options)) {
      rejectTlsOptions(norm.options, true);
      // Node's agent calls tls.connect inside https.request, so key material
      // that isn't (ERR_OSSL_*) throws from it; jsh's agent connects later.
      // Only https's own connection parses it: a createConnection of the
      // caller's (or an agent's own) gets cert and key as given, as in Node.
      const { cert, key, secureContext, createConnection, agent } = norm.options;
      const used = agent === false || agent == null ? globalAgent : agent;
      const ownTls =
        typeof createConnection !== 'function' && used instanceof Agent && used.createConnection === Agent.prototype.createConnection;
      if (ownTls && (cert != null || key != null) && secureContext == null) getTls().createSecureContext(norm.options);
      // Node's agent: false is a fresh agent of the default's kind (not a plain socket).
      const own = norm.options.agent === false && typeof norm.options.createConnection !== 'function' ? { agent: new Agent() } : {};
      return http.request(
        { _defaultAgent: globalAgent, defaultPort: 443, port: 443, ...norm.options, ...own, protocol: 'https:' },
        norm.callback
      );
    }
    rejectTlsOptions(norm.options);
    return new http.ClientRequest(
      {
        _defaultAgent: globalAgent,
        defaultPort: 443,
        ...norm.options,
        protocol: 'https:',
        [kFetchVia]: { send },
      },
      norm.callback
    );
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
    Agent,
    globalAgent,
    Server,
    createServer,
    get,
    request,
  };
}
