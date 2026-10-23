import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devPackageFiles, withJsh } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

// ws requires tls at load, even for plain ws://. The golden tls-node22 pins
// the module's surface against Node; here the real package runs in a kernel
// program, and what needs a handshake throws when it is called.
describe('tls (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it('the real ws@8.22.0 loads, and its server and client echo over http upgrade', async () => {
    const version = JSON.parse(readFileSync(join(root, 'node_modules/ws/package.json'), 'utf8')).version;
    assert.equal(version, '8.22.0');
    for (const [path, data] of devPackageFiles('ws')) {
      await jsh.kernel.writeFile(`/os${path}`, data);
    }
    await jsh.kernel.writeFile(
      '/os/ws-echo.js',
      `const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const server = http.createServer((req, res) => res.end('plain'));
const wss = new WebSocketServer({ server });
wss.on('connection', (peer, req) => {
  console.log('server connection', req.url);
  peer.on('message', (data, isBinary) => peer.send(isBinary ? data : 'echo ' + data, { binary: isBinary }));
  peer.on('close', (code, reason) => console.log('server close', code, String(reason)));
});
server.listen(0, '127.0.0.1', () => {
  const ws = new WebSocket('ws://127.0.0.1:' + server.address().port + '/chat');
  const got = [];
  ws.on('open', () => {
    ws.send('hello');
    ws.send(Buffer.from([1, 2, 3]));
  });
  ws.on('message', (data, isBinary) => {
    got.push(isBinary ? 'binary ' + [...data].join(',') : String(data));
    if (got.length === 2) {
      console.log('client got', JSON.stringify(got));
      ws.close(1000, 'done');
    }
  });
  ws.on('error', (err) => console.log('client error', err.code, err.message));
  ws.on('close', (code, reason) => {
    console.log('client close', code, String(reason));
    wss.close();
    server.close(() => console.log('server closed'));
  });
});
`
    );
    const r = await jsh.run(['node', 'ws-echo.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    // The two ends' closes race (on the kernel's loopback as over TCP): only
    // the first two lines have an order.
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.deepEqual(lines.slice(0, 2), ['server connection /chat', 'client got ["echo hello","binary 1,2,3"]']);
    assert.deepEqual(lines.slice(2).sort(), ['client close 1000 done', 'server close 1000 done', 'server closed']);
  });

  it("a connection a tls.Server without a certificate gets is a failed handshake: 'tlsClientError' with Node's no suitable signature algorithm and the socket destroyed, an https.Server's 'clientError', the client closed (#792, #758)", async () => {
    const r = await jsh.run([
      'node',
      '-e',
      `const tls = require('tls');
const net = require('net');
const https = require('https');
const through = (label, server) => new Promise((resolve) => {
  const plain = net.createServer((sock) => {
    server.emit('connection', sock);
    console.log(label, 'given, destroyed at once', sock.destroyed);
    plain.close();
  });
  plain.listen(0, '127.0.0.1', () => {
    const c = net.connect(plain.address().port, '127.0.0.1');
    const bound = setTimeout(() => {
      console.log(label, 'client still open after 5 s');
      c.destroy();
    }, 5000);
    c.on('error', (e) => console.log(label, 'client error', e.code));
    c.on('close', () => {
      clearTimeout(bound);
      console.log(label, 'client close');
      setImmediate(resolve);
    });
  });
});
process.on('uncaughtException', (e) => console.log('uncaught', e.code));
(async () => {
  const told = tls.createServer();
  told.on('tlsClientError', (e, sock) => console.log('tlsClientError', e.code, sock.destroyed, sock instanceof net.Socket));
  await through('a listener', told);
  await through('no listener', tls.createServer());
  const web = https.createServer();
  web.on('clientError', (e, sock) => console.log('https clientError', e.code, sock.destroyed));
  await through('https', web);
  console.log(told.listeners('connection').map((f) => f.name).join());
})();
`,
    ]);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.trimEnd().split('\n'), [
      'a listener given, destroyed at once false',
      'tlsClientError ERR_SSL_NO_SUITABLE_SIGNATURE_ALGORITHM true true',
      'a listener client close',
      'no listener given, destroyed at once false',
      'no listener client close',
      'https given, destroyed at once false',
      'https clientError ERR_SSL_NO_SUITABLE_SIGNATURE_ALGORITHM true',
      'https client close',
      'tlsConnectionListener',
    ]);
  });

  it('what the kernel has no handshake for throws ERR_NOT_SUPPORTED when it is called, and a tls.Server and an https.Server listen (#758)', async () => {
    const r = await jsh.run([
      'node',
      '-e',
      `const tls = require('tls');
const net = require('net');
const https = require('https');
const t = (label, f) => {
  try {
    f();
    console.log(label, 'no throw');
  } catch (e) {
    console.log(label, e.code, e.message);
  }
};
console.log('loaded', typeof tls.connect);
t('connect', () => tls.connect({ socket: new net.Socket() }));
t('connect options', () => tls.connect(443, 'example.com', { socket: new net.Socket(), servername: 'example.com' }, () => {}));
const server = tls.createServer(() => {});
t('listen', () => server.listen(0));
console.log('listening', server.listening);
t('TLSSocket over a socket', () => new tls.TLSSocket(new net.Socket()));
t('TLSSocket connect', () => new tls.TLSSocket().connect(443, 'example.com'));
t('createSecureContext cert', () => tls.createSecureContext({ cert: '-----BEGIN CERTIFICATE-----' }));
t('createSecureContext key', () => tls.createSecureContext({ key: 'k' }));
t('createSecureContext ca', () => tls.createSecureContext({ ca: ['c'] }));
t('createServer key', () => tls.createServer({ key: 'k', cert: 'c' }));
t('createSecurePair', () => tls.createSecurePair());
t('https.createServer', () => https.createServer());
const web = https.createServer();
t('https listen', () => web.listen(0));
console.log('https listening', web.listening);
server.close();
web.close();
const httpsServer = new https.Server();
console.log('https.Server', httpsServer instanceof tls.Server, Object.getPrototypeOf(https.Server.prototype) === tls.Server.prototype, https.Server !== require('http').Server, httpsServer.listening);
`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const why = '(no TLS on ctx.net)';
    assert.deepEqual(r.stdout.split('\n'), [
      'loaded function',
      'connect no throw',
      'connect options no throw',
      'listen no throw',
      'listening true',
      'TLSSocket over a socket no throw',
      `TLSSocket connect ERR_NOT_SUPPORTED slicc-jsh: 'tls.TLSSocket.connect' is not supported yet ${why}`,
      'createSecureContext cert ERR_OSSL_PEM_BAD_END_LINE error:04800066:PEM routines::bad end line',
      'createSecureContext key ERR_OSSL_UNSUPPORTED error:1E08010C:DECODER routines::unsupported',
      'createSecureContext ca no throw',
      'createServer key ERR_OSSL_PEM_NO_START_LINE error:0480006C:PEM routines::no start line',
      `createSecurePair ERR_NOT_SUPPORTED slicc-jsh: 'tls.createSecurePair' is not supported yet ${why}`,
      'https.createServer no throw',
      'https listen no throw',
      'https listening true',
      'https.Server true true true false',
      '',
    ]);
    // tls.createSecurePair is deprecated (DEP0064), as in Node.
    assert.match(r.stderr, /\[DEP0064\] DeprecationWarning: tls\.createSecurePair\(\) is deprecated/);
  });
});
