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

  it('a handshake throws ERR_NOT_SUPPORTED when it is called: connect, listen, a TLSSocket over a socket, key material', async () => {
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
t('connect', () => tls.connect(443, 'example.com'));
t('connect options', () => tls.connect({ host: 'example.com', port: 443, servername: 'example.com' }, () => {}));
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
`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const why = '(no TLS on ctx.net)';
    assert.deepEqual(r.stdout.split('\n'), [
      'loaded function',
      `connect ERR_NOT_SUPPORTED slicc-jsh: 'tls.connect' is not supported yet ${why}`,
      `connect options ERR_NOT_SUPPORTED slicc-jsh: 'tls.connect' is not supported yet ${why}`,
      `listen ERR_NOT_SUPPORTED slicc-jsh: 'tls.Server.listen' is not supported yet ${why}`,
      'listening false',
      `TLSSocket over a socket ERR_NOT_SUPPORTED slicc-jsh: 'tls.TLSSocket over a socket' is not supported yet ${why}`,
      `TLSSocket connect ERR_NOT_SUPPORTED slicc-jsh: 'tls.TLSSocket.connect' is not supported yet ${why}`,
      `createSecureContext cert ERR_NOT_SUPPORTED slicc-jsh: 'tls.createSecureContext option 'cert'' is not supported yet ${why}`,
      `createSecureContext key ERR_NOT_SUPPORTED slicc-jsh: 'tls.createSecureContext option 'key'' is not supported yet ${why}`,
      `createSecureContext ca ERR_NOT_SUPPORTED slicc-jsh: 'tls.createSecureContext option 'ca'' is not supported yet ${why}`,
      `createServer key ERR_NOT_SUPPORTED slicc-jsh: 'tls.createSecureContext option 'cert'' is not supported yet ${why}`,
      `createSecurePair ERR_NOT_SUPPORTED slicc-jsh: 'tls.createSecurePair' is not supported yet ${why}`,
      `https.createServer ERR_NOT_SUPPORTED slicc-jsh: 'https.createServer' is not supported yet ${why}`,
      '',
    ]);
    // tls.createSecurePair is deprecated (DEP0064), as in Node.
    assert.match(r.stderr, /\[DEP0064\] DeprecationWarning: tls\.createSecurePair\(\) is deprecated/);
  });
});
