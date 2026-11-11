import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpsServer } from 'node:https';
import { connect as tcp } from 'node:net';
import { fakeUplink } from '@ai-ecoverse/slicc-kernel/testing';
import { withJsh, devPackageTree } from './helpers.mjs';
import { makeCa } from './tls-certs.mjs';

const UPLINK = '203.0.113.10';

function pipeTo(port) {
  return (peer) => {
    const sock = tcp(port, '127.0.0.1');
    sock.on('data', (d) => peer.write(new Uint8Array(d)));
    sock.on('end', () => peer.end());
    sock.on('error', () => peer.end());
    void (async () => {
      for (;;) {
        const bytes = await peer.read().catch(() => null);
        if (!bytes) {
          sock.end();
          return;
        }
        sock.write(bytes);
      }
    })();
  };
}

describe('undici https fetch keeps the program alive (#1270)', () => {
  const ca = makeCa();
  const leaf = ca.server('slow.test', { san: ['DNS:slow.test', 'IP:127.0.0.1', `IP:${UPLINK}`] });
  let server;
  let port;
  let jsh;

  before(async () => {
    server = createHttpsServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
      if (req.url === '/pause') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' });
        const chunk = Buffer.alloc(256, 0x41);
        for (let i = 0; i < 16; i++) res.write(chunk);
        setTimeout(() => res.end(), 200);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    jsh = await withJsh({
      uplink: fakeUplink({
        names: { 'slow.test': [UPLINK] },
        routes: { prefixes: [], exit: true },
        peers: { [`${UPLINK}:${port}`]: pipeTo(port) },
      }),
      tlsEngine: true,
    });
    for (const [path, data] of devPackageTree('undici')) await jsh.kernel.writeFile(`/os${path}`, data);
    await jsh.kernel.writeFile('/os/ca.pem', ca.pem);
    await jsh.kernel.writeFile('/os/package.json', JSON.stringify({ type: 'module' }));
  });

  after(() => {
    jsh?.close();
    server?.close();
  });

  it('npm undici does not reuse Node undici Agent on the shared dispatcher slot', async () => {
    await jsh.kernel.writeFile(
      '/os/undici-dispatcher.mjs',
      `import { createRequire } from 'module';
const require = createRequire('/os/undici-dispatcher.mjs');
const nodeSym = Symbol.for('undici.globalDispatcher.2');
const jshSym = Symbol.for('slicc-jsh.undici.globalDispatcher.2');
Object.defineProperty(globalThis, nodeSym, {
  value: { dispatch() { return false; }, close() {}, destroy() {} },
  writable: true,
  enumerable: false,
  configurable: false,
});
const undici = require('/os/node_modules/undici/index.js');
const fs = require('fs');
if (undici.getGlobalDispatcher() === globalThis[nodeSym]) {
  throw new Error('npm undici reused Node dispatcher slot');
}
if (globalThis[jshSym] == null) {
  throw new Error('npm undici did not install on slicc-jsh dispatcher slot');
}
const ca = fs.readFileSync('/os/ca.pem');
undici.setGlobalDispatcher(new undici.Agent({
  connect: { ca, servername: 'slow.test', rejectUnauthorized: true },
  allowH2: false,
}));
const host = process.argv[2];
const port = Number(process.argv[3]);
const r = await undici.fetch('https://' + host + ':' + port + '/');
const text = await r.text();
console.log('ok', r.status, text, typeof globalThis[nodeSym].dispatch);
`
    );
    const out = await jsh.run(['node', 'undici-dispatcher.mjs', UPLINK, String(port)]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /^ok 200 ok function$/m);
    assert.doesNotMatch(out.stderr, /unsettled top-level await/);
  });

  it('a high-water-mark pause on a TLS socket keeps the program alive', async () => {
    await jsh.kernel.writeFile(
      '/os/tls-hwm-pause.mjs',
      `import tls from 'tls';
import fs from 'fs';
const ca = fs.readFileSync('/os/ca.pem');
const host = process.argv[2];
const port = Number(process.argv[3]);
const socket = tls.connect({
  host,
  port,
  servername: 'slow.test',
  ca,
  rejectUnauthorized: true,
});
await new Promise((resolve, reject) => {
  socket.once('secureConnect', resolve);
  socket.once('error', reject);
});
socket._readableState.highWaterMark = 64;
console.log('hwm', socket.readableHighWaterMark);
socket.write('GET /pause HTTP/1.1\\r\\nHost: slow.test\\r\\nConnection: close\\r\\n\\r\\n');
await new Promise((resolve) => {
  const t = setTimeout(resolve, 150);
  t.unref?.();
});
console.log('after-pause', socket.readableLength);
let total = 0;
const ended = new Promise((resolve) => {
  if (socket.readableEnded) resolve();
  else socket.once('end', resolve);
});
for (;;) {
  let chunk = socket.read();
  while (chunk) {
    total += chunk.length;
    chunk = socket.read();
  }
  if (socket.readableEnded) break;
  await Promise.race([
    ended,
    new Promise((resolve) => socket.once('readable', resolve)),
  ]);
  if (socket.readableEnded && socket.readableLength === 0) break;
}
await ended;
console.log('body', total);
console.log('DONE');
`
    );
    const out = await jsh.run(['node', 'tls-hwm-pause.mjs', UPLINK, String(port)]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /^hwm 64$/m);
    assert.match(out.stdout, /^after-pause /m);
    assert.match(out.stdout, /^DONE$/m);
    assert.doesNotMatch(out.stderr, /unsettled top-level await/);
  });
});
