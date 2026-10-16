import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// Node's net.Server.close(): it stops accepting, and its 'close' comes once
// every connection has ended (_emitCloseIfDrained, on the tick after the last
// socket's _destroy, so before that socket's own 'close'). jsh emitted it once
// the kernel had closed the listener, with a connection still open, and
// getConnections said 0: m2/fin2.js printed `srv closed` before `server end`
// (ai-ecoverse/slicc-jsh#236).
describe('net.Server close waits for its connections (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it("'close' comes after the open connection ends, before that socket's 'close', as in Node", async () => {
    // The client ends 100 ms after it connects, long after close() was
    // called, so the order doesn't depend on timing.
    await jsh.kernel.writeFile(
      '/os/srvclose.js',
      `const net = require('net');
const ev = [];
const srv = net.createServer((s) => {
  s.on('end', () => ev.push('server end'));
  s.on('close', () => { ev.push('server close'); setTimeout(() => console.log(ev.join(',')), 20); });
  srv.getConnections((err, n) => {
    ev.push('connections ' + n);
    srv.close(() => ev.push('srv closed'));
    ev.push('close called');
  });
});
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1');
  c.on('connect', () => setTimeout(() => { ev.push('client end'); c.end(); }, 100));
  c.resume();
});
`
    );
    const r = await jsh.run(['node', '/os/srvclose.js']);
    assert.equal(r.stdout, 'connections 1,close called,client end,server end,srv closed,server close\n');
  });

  it('a server closed with no connection: its port is free from the close callback', async () => {
    await jsh.kernel.writeFile(
      '/os/relisten.js',
      `const net = require('net');
const a = net.createServer();
a.listen(0, '127.0.0.1', () => {
  const port = a.address().port;
  a.close(() => {
    const b = net.createServer();
    b.on('error', (e) => console.log('b error', e.code));
    b.listen(port, '127.0.0.1', () => { console.log('b listening'); b.close(() => console.log('b closed')); });
  });
});
`
    );
    const r = await jsh.run(['node', '/os/relisten.js']);
    assert.equal(r.stdout, 'b listening\nb closed\n');
  });
});
