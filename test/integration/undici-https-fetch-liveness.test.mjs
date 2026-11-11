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

  it('npm undici fetch loop over loopback https stays alive', async () => {
    await jsh.kernel.writeFile(
      '/os/undici-fetch-loop.mjs',
      `import { createRequire } from 'module';
const require = createRequire('/os/undici-fetch-loop.mjs');
const nodeSym = Symbol.for('undici.globalDispatcher.2');
const jshSym = Symbol.for('slicc-jsh.undici.globalDispatcher.2');
const planted = { dispatch() { return false; }, close() {}, destroy() {} };
Object.defineProperty(globalThis, nodeSym, {
  value: planted,
  writable: true,
  enumerable: false,
  configurable: false,
});
const undici = require('/os/node_modules/undici/index.js');
if (undici.getGlobalDispatcher() === planted) {
  throw new Error('npm undici reused Node dispatcher slot');
}
if (globalThis[jshSym] == null) {
  throw new Error('npm undici did not install on slicc-jsh dispatcher slot');
}
const fs = require('fs');
const ca = fs.readFileSync('/os/ca.pem');
undici.setGlobalDispatcher(new undici.Agent({
  connect: { ca, servername: 'slow.test', rejectUnauthorized: true },
  allowH2: false,
}));
const host = process.argv[2];
const port = Number(process.argv[3]);
const url = 'https://' + host + ':' + port + '/';
for (let i = 0; i < 30; i++) {
  const r = await undici.fetch(url);
  await r.text();
}
console.log('DONE');
`
    );
    const out = await jsh.run(['node', 'undici-fetch-loop.mjs', UPLINK, String(port)]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /^DONE$/m);
    assert.doesNotMatch(out.stderr, /unsettled top-level await/);
  });
});
