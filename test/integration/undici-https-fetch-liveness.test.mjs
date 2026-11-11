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
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' });
      res.write('A'.repeat(32));
      setTimeout(() => {
        res.write('B'.repeat(32));
      }, 40);
      setTimeout(() => {
        res.write('C'.repeat(32));
        res.end();
      }, 120);
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

  it('npm undici fetch over loopback https reads a slow chunked body to the end', async () => {
    await jsh.kernel.writeFile(
      '/os/undici-slow.mjs',
      `import { fetch, Agent, setGlobalDispatcher, getGlobalDispatcher } from '/os/node_modules/undici/index.js';
import fs from 'fs';
const ca = fs.readFileSync('/os/ca.pem');
const host = process.argv[2];
const port = Number(process.argv[3]);
if (getGlobalDispatcher()?.constructor?.toString().includes('__name')) {
  throw new Error('Node undici Agent still installed as global dispatcher');
}
setGlobalDispatcher(new Agent({
  connect: { ca, servername: 'slow.test', rejectUnauthorized: true },
  allowH2: false,
}));
for (let i = 0; i < 4; i++) {
  const r = await fetch('https://' + host + ':' + port + '/');
  const buf = await r.arrayBuffer();
  console.log('iter', i, r.status, buf.byteLength);
}
console.log('DONE');
`
    );
    const out = await jsh.run(['node', 'undici-slow.mjs', UPLINK, String(port)]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /^iter 0 200 96$/m);
    assert.match(out.stdout, /^iter 3 200 96$/m);
    assert.match(out.stdout, /^DONE$/m);
    assert.equal(out.stderr, '');
  });

  it('npm undici default dispatcher fetch over https completes without exit 13', async () => {
    await jsh.kernel.writeFile(
      '/os/undici-default.mjs',
      `import { fetch, getGlobalDispatcher } from '/os/node_modules/undici/index.js';
const d = getGlobalDispatcher();
console.log('bundled', !!(d && d.constructor.toString().includes('__name')));
const r = await fetch('https://example.com/');
const buf = await r.arrayBuffer();
console.log('ok', r.status, buf.byteLength);
`
    );
    const out = await jsh.run(['node', 'undici-default.mjs']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /^bundled false$/m);
    assert.match(out.stdout, /^ok 200 \d+$/m);
    assert.doesNotMatch(out.stderr, /unsettled top-level await/);
  });
});
