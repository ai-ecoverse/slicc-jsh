import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { withJsh } from './helpers.mjs';

// slicc-kernel 1.84.0: nodeTransport() refuses the host's own loopback
// unless nodeTransport({ hostLoopback }) asks for it. Tests that talk to a
// host server opt in (withJsh({ hostLoopback: true })); this pins that the
// default refuses, for fetch and for a WebSocket, as the kernel documents.
describe("nodeTransport's default refuses the host's loopback (kernel 1.84.0)", () => {
  let server;
  let wss;
  let port;
  before(async () => {
    server = createServer((req, res) => res.end('host server'));
    wss = new WebSocketServer({ server });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(async () => {
    wss?.close();
    await new Promise((r) => server.close(r));
  });

  const script = (p) => `
(async () => {
  // host.slicc.internal is the real machine (127.0.0.1 is the kernel's own
  // loopback for jsh's fetch), so it is what reaches the transport's check.
  for (const host of ['host.slicc.internal']) {
    try {
      const r = await fetch('http://' + host + ':${p}/');
      const body = await r.text();
      console.log('fetch', host, r.status, /hostLoopback/.test(body) ? 'names hostLoopback' : JSON.stringify(body));
    } catch (e) {
      console.log('fetch', host, 'threw', e.cause && e.cause.code);
    }
  }
  await new Promise((resolve) => {
    const w = new WebSocket('ws://host.slicc.internal:${p}/');
    w.onopen = () => { console.log('ws open'); w.close(); resolve(); };
    w.onerror = () => { console.log('ws error'); resolve(); };
  });
})();
`;

  it('refuses by default: fetch gets a 403 naming the option, a WebSocket an error', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile('/os/refused.js', script(port));
      const r = await run(['node', 'refused.js']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^fetch host\.slicc\.internal 403 names hostLoopback$/m);
      assert.match(r.stdout, /^ws error$/m);
      assert.doesNotMatch(r.stdout, /host server|ws open/);
    } finally {
      close();
    }
  });

  it('reaches the host server with the opt-in', async () => {
    const { kernel, run, close } = await withJsh({ hostLoopback: true });
    try {
      await kernel.writeFile('/os/allowed.js', script(port));
      const r = await run(['node', 'allowed.js']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^fetch host\.slicc\.internal 200 "host server"$/m);
      assert.match(r.stdout, /^ws open$/m);
    } finally {
      close();
    }
  });
});
