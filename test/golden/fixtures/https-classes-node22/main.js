const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const { Stream } = require('stream');

console.log('https exports', Object.keys(https));
console.log('Server chain', Object.getPrototypeOf(https.Server.prototype) === tls.Server.prototype, Object.getPrototypeOf(https.Server) === tls.Server);
console.log('Server own', Object.getOwnPropertyNames(https.Server.prototype));
console.log('from http.Server', ['closeAllConnections', 'closeIdleConnections', 'setTimeout'].map((k) => https.Server.prototype[k] === http.Server.prototype[k]));
console.log('close', https.Server.prototype.close !== http.Server.prototype.close, https.Server.prototype.close !== tls.Server.prototype.close);
console.log('asyncDispose', typeof https.Server.prototype[Symbol.asyncDispose]);

const s = new https.Server();
console.log('instances', s instanceof https.Server, s instanceof tls.Server, s instanceof net.Server, s instanceof http.Server);
console.log('defaults', s.timeout, s.keepAliveTimeout, s.headersTimeout, s.requestTimeout, s.maxHeadersCount, s.httpAllowHalfOpen);
console.log('ALPN', s.ALPNProtocols);
const withCallback = new https.Server({ ALPNCallback: () => 'http/1.1' });
console.log('ALPNCallback', withCallback.ALPNProtocols, typeof withCallback.ALPNCallback);
console.log('ALPNProtocols', new https.Server({ ALPNProtocols: ['h2'] }).ALPNProtocols);
try {
  new https.Server({ ALPNCallback: () => 'h2', ALPNProtocols: ['h2'] });
} catch (err) {
  console.log('both', err.code);
}
console.log('listeners', ['request', 'secureConnection', 'tlsClientError'].map((e) => s.listenerCount(e)));
const handler = () => {};
const created = https.createServer(handler);
console.log('createServer', created instanceof https.Server, created.listeners('request')[0] === handler);
const called = https.Server({ requestTimeout: 1000, headersTimeout: 500 }, handler);
console.log('without new', called instanceof https.Server, called.requestTimeout, called.headersTimeout, called.listenerCount('request'));
console.log('setTimeout', s.setTimeout(10) === s, s.timeout);
try {
  https.Server({ requestTimeout: -1 });
} catch (err) {
  console.log('bad option', err.code);
}
console.log('address before listen', s.address());

const req = https.request('https://127.0.0.1:1/x?y=1', { headers: { 'X-A': 'b' } });
const events = [];
req.on('error', (err) => events.push(`error ${err.message}`));
req.on('close', () => {
  events.push('close');
  console.log('destroyed request', events);
  refused();
});
console.log('ClientRequest', req instanceof http.ClientRequest, req instanceof http.OutgoingMessage, req instanceof Stream, req.constructor === http.ClientRequest);
console.log('agent', req.agent === https.globalAgent);
console.log('what', req.method, req.path, req.host, req.protocol);
req.appendHeader('X-A', 'c');
req.setHeaders(new Map([['x-b', '1']]));
console.log('headers', req.getHeaders(), req.getHeaderNames(), req.getRawHeaderNames(), req.hasHeader('X-B'));
console.log('state', req.writable, req.writableEnded, req.headersSent, req.finished, req.destroyed);
console.log('methods', ['flushHeaders', 'setNoDelay', 'setSocketKeepAlive', 'abort', 'onSocket', 'getHeader', 'removeHeader', 'write', 'end', 'pipe'].map((k) => typeof req[k]));
req.destroy(new Error('stop'));

function refused() {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => {
      const seen = [];
      const r = https.get(`https://127.0.0.1:${port}/p?q`, () => seen.push('response'));
      console.log('sent', r.headersSent, JSON.stringify(r._header.replace(String(port), 'PORT')));
      for (const change of [() => r.setHeader('x-late', '1'), () => r.removeHeader('host'), () => r.appendHeader('x-late', '2')]) {
        try {
          change();
          console.log('changed after end');
        } catch (err) {
          console.log('after end', err.code);
        }
      }
      r.on('error', (err) => seen.push(`error ${err.code} ${err.message.replace(String(port), 'PORT')}`));
      r.on('close', () => {
        seen.push('close');
        console.log('refused', seen, r instanceof http.ClientRequest);
      });
    });
  });
}
