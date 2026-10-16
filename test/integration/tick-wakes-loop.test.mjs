import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// Node runs a callback's nextTicks before the next event (the callback
// scope's processTicksAndRejections). jsh's event loop runs them when it
// wakes, and it only woke for a ref'd handle: a tick queued by a promise
// that isn't one of them (the socket's writer.close() behind 'finish')
// waited for the next unrelated event (ai-ecoverse/slicc-jsh#236).
describe('a nextTick wakes the event loop (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it("a socket's 'finish' comes when its end() is done, not at the next unrelated event", async () => {
    // The peer is another process that keeps its side open (allowHalfOpen),
    // so nothing else happens here until the timer: before the fix, the
    // client's 'finish' (queued by its writer.close(), which the loop doesn't
    // track) waited for the 2 s timer. Node: 'finish' at once.
    let gotPort;
    const port = new Promise((resolve) => (gotPort = resolve));
    let out = '';
    const server = jsh.run(
      [
        'node',
        '-e',
        "const s = require('net').createServer({ allowHalfOpen: true }, (c) => c.on('end', () => setTimeout(() => { c.end(); s.close(); }, 2500))); s.listen(0, '127.0.0.1', () => console.log(s.address().port));",
      ],
      {
        onStdout: (t) => {
          out += t;
          if (out.includes('\n')) gotPort(Number(out.trim()));
        },
      }
    );
    const p = await port;
    const r = await jsh.run([
      'node',
      '-e',
      `const t = setTimeout(() => console.log('timer'), 2000); const c = require('net').connect(${p}, '127.0.0.1', () => c.end()); c.resume(); c.on('finish', () => { console.log('finish'); clearTimeout(t); });`,
    ]);
    assert.equal(r.stdout, 'finish\n');
    assert.equal((await server).status, 0);
  });

  it("net: the client's 'close' comes before the server's 'end' of the client's FIN, as in Node", async () => {
    // m2/fin3.js: the client's end() resolves its writer.close() (not a
    // tracked handle); its 'finish' and 'close' ticks waited until the
    // server's read of the FIN woke the loop, so 'server end' came first in
    // about 6 runs out of 10. Node: the shutdown's callback, then the
    // client's close, in one loop turn; the server reads the FIN on the next.
    await jsh.kernel.writeFile(
      '/os/fin3.js',
      `const net = require('net');
const ev = [];
const srv = net.createServer((s) => {
  s.on('end', () => ev.push('server end'));
  s.on('close', () => { ev.push('server close'); srv.close(); console.log(ev.join(',')); });
  s.end('hello');
});
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1');
  c.resume();
  c.on('end', () => ev.push('client end'));
  c.on('finish', () => ev.push('client finish'));
  c.on('close', () => ev.push('client close'));
});
`
    );
    const want = 'client end,client finish,client close,server end,server close\n';
    for (let i = 0; i < 10; i++) {
      const r = await jsh.run(['node', '/os/fin3.js']);
      assert.equal(r.stdout, want, `run ${i}`);
    }
  });
});
