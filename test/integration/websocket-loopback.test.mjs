/**
 * WebSocket to a loopback URL reaches a server of this kernel (as fetch
 * does), here the kernel's CDP facade on 127.0.0.1:9222 behind
 * SLICC_CDP_URL: ctx.websocket would go to the transport instead (the
 * host's 9222 on the Node entry, ENOTSUP in a page). ai-ecoverse/slicc-jsh#73.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createNodeKernel } from '@ai-ecoverse/slicc-kernel/node';
import { createNodeKernel as createKernel186 } from 'kernel-cert-186/node';
import { WebSocketServer } from 'ws';
import { openLoopbackWebSocket } from '../../src/runtime/web/websocket-loopback.mjs';
import { packageFiles } from './helpers.mjs';

async function withCdp(answer, createKernel = createNodeKernel) {
  const opened = [];
  const kernel = await createKernel({
    cdp: async () => {
      const conn = {
        onmessage: null,
        onclose: null,
        sent: [],
        closed: false,
        send(text) {
          conn.sent.push(JSON.parse(text));
          for (const reply of answer(JSON.parse(text))) setTimeout(() => conn.onmessage?.(JSON.stringify(reply)), 5);
        },
        close() {
          conn.closed = true;
        },
      };
      opened.push(conn);
      return conn;
    },
  });
  for (const [rel, data] of packageFiles()) await kernel.writeFile(`/node_modules/@ai-ecoverse/slicc-jsh/${rel}`, data);
  return { kernel, opened, run: (argv) => kernel.run(argv, { cwd: '/os' }), close: () => kernel.terminate() };
}

const echo = ({ id, method }) => [
  { id, result: { method, big: 'x'.repeat(70000) } },
  ...(method === 'Target.setDiscoverTargets' ? [{ method: 'Target.targetCreated', params: { n: 1 } }] : []),
];

// Both paths a loopback WebSocket can take: the kernel's own ctx.websocket
// (slicc-kernel 1.106.3 and later, the devDependency) and jsh's RFC 6455
// client over the kernel's sockets (older kernels; 1.86.0 here). Node's
// answers are the same on both.
for (const [path, createKernel] of [
  ['ctx.websocket, slicc-kernel 1.106.3+', createNodeKernel],
  ["jsh's own client, slicc-kernel 1.86.0", createKernel186],
]) describe(`WebSocket to the kernel loopback (${path})`, () => {
  it('reaches the CDP facade at SLICC_CDP_URL: commands, a 70 kB answer, events, a clean close', async () => {
    const { kernel, opened, run, close } = await withCdp(echo, createKernel);
    try {
      await kernel.writeFile(
        '/os/cdp.js',
        `const ws = new WebSocket(process.env.SLICC_CDP_URL);
ws.onopen = () => { console.log('open', ws.readyState, JSON.stringify(ws.protocol)); ws.send(JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets' })); };
let n = 0;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  console.log('message', typeof e.data, m.id ?? m.method, m.result ? m.result.big.length : m.params.n);
  if (++n === 2) ws.close(1000, 'done');
};
ws.onerror = (e) => console.log('error', e.error && e.error.cause && e.error.cause.code);
ws.onclose = (e) => console.log('close', e.code, e.wasClean, ws.readyState);
`
      );
      assert.deepEqual(await run(['node', 'cdp.js']), {
        status: 0,
        stdout: 'open 1 ""\nmessage string 1 70000\nmessage string Target.targetCreated 1\nclose 1000 true 3\n',
        stderr: '',
      });
      assert.equal(opened.length, 1);
      assert.deepEqual(opened[0].sent, [{ id: 1, method: 'Target.setDiscoverTargets' }]);
      assert.equal(opened[0].closed, true);
    } finally {
      close();
    }
  });

  it('a jsh script sees the facade through fetch and WebSocket alike', async () => {
    const { kernel, run, close } = await withCdp(echo, createKernel);
    try {
      await kernel.writeFile(
        '/os/both.jsh',
        `const version = await (await fetch('http://127.0.0.1:9222/json/version')).json();
console.log('same url', version.webSocketDebuggerUrl === process.env.SLICC_CDP_URL);
const answer = await new Promise((resolve, reject) => {
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  ws.onopen = () => ws.send(JSON.stringify({ id: 7, method: 'Browser.getVersion' }));
  ws.onmessage = (e) => { ws.close(); resolve(JSON.parse(e.data)); };
  ws.onerror = (e) => reject(e.error);
});
console.log('answer', answer.id, answer.result.method);
`
      );
      assert.deepEqual(await run(['jsh', 'both.jsh']), {
        status: 0,
        stdout: 'same url true\nanswer 7 Browser.getVersion\n',
        stderr: '',
      });
    } finally {
      close();
    }
  });

  it('a refused loopback port is an error Event with ECONNREFUSED and no close, as Node 22', async () => {
    const { kernel, run, close } = await withCdp(echo, createKernel);
    try {
      await kernel.writeFile(
        '/os/refused.js',
        `const ws = new WebSocket('ws://localhost:9/');
ws.onerror = (e) => console.log('error', e instanceof Event, e.error.cause.code, ws.readyState);
ws.onclose = () => console.log('close');
`
      );
      assert.deepEqual(await run(['node', 'refused.js']), { status: 0, stdout: 'error true ECONNREFUSED 0\n', stderr: '' });
    } finally {
      close();
    }
  });

  it('the facade with no browser attached refuses the upgrade (503): an error Event', async () => {
    const kernel = await createKernel();
    try {
      for (const [rel, data] of packageFiles()) await kernel.writeFile(`/node_modules/@ai-ecoverse/slicc-jsh/${rel}`, data);
      await kernel.writeFile(
        '/os/nohost.js',
        `const ws = new WebSocket(process.env.SLICC_CDP_URL);
ws.onopen = () => console.log('open');
ws.onerror = (e) => console.log('error', e.error.cause.code, e.error.cause.message);
`
      );
      assert.deepEqual(await kernel.run(['node', 'nohost.js'], { cwd: '/os' }), {
        status: 0,
        // The cause's message is the kernel's or jsh's (Node's ErrorEvent
        // has no cause): the kernel names the status text too.
        stdout: `error EPROTO the server answered the upgrade with 503${createKernel === createNodeKernel ? ' Service Unavailable' : ''}\n`,
        stderr: '',
      });
    } finally {
      kernel.terminate();
    }
  });

  it('holds a server to RFC 6455, as undici does: masked, reserved-bit and long control frames, a bad handshake, the closing handshake', async () => {
    const { kernel, run, close } = await withCdp(echo, createKernel);
    try {
      await kernel.writeFile(
        '/os/strict.js',
        `const net = require('net');
const { createHash } = require('crypto');
const echoes = [];
const server = net.createServer((sock) => {
  let head = '';
  sock.on('data', function first(chunk) {
    head += chunk.toString('latin1');
    if (!head.includes('\\r\\n\\r\\n')) return;
    sock.off('data', first);
    const path = head.split(' ')[1];
    const key = /sec-websocket-key: (.*)\\r\\n/i.exec(head)[1];
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket'];
    if (path !== '/noconn') lines.push('Connection: Upgrade');
    if (path === '/ext') lines.push('Sec-WebSocket-Extensions: permessage-deflate');
    lines.push('Sec-WebSocket-Accept: ' + accept);
    sock.write(lines.join('\\r\\n') + '\\r\\n\\r\\n');
    const text = Buffer.from('hi');
    if (path === '/masked') sock.write(Buffer.concat([Buffer.from([0x81, 0x82, 1, 2, 3, 4]), Buffer.from([text[0] ^ 1, text[1] ^ 2])]));
    if (path === '/rsv') sock.write(Buffer.concat([Buffer.from([0xc1, 2]), text]));
    if (path === '/bigping') sock.write(Buffer.concat([Buffer.from([0x89, 126, 0, 126]), Buffer.alloc(126)]));
    if (path === '/drop') setTimeout(() => sock.destroy(), 50);
    if (path === '/close') {
      sock.write(Buffer.concat([Buffer.from([0x88, 5, 0x0f, 0xa1]), Buffer.from('bye')]));
      sock.on('data', (c) => { echoes.push((c[0] & 0x0f) + ':' + (((c[2] ^ c[6]) << 8) | (c[3] ^ c[7]))); sock.end(); });
    }
  });
});
const one = (path) => new Promise((resolve) => {
  const ev = [];
  const ws = new WebSocket('ws://127.0.0.1:' + server.address().port + path);
  ws.onopen = () => ev.push('open');
  ws.onmessage = (e) => ev.push('message ' + e.data);
  ws.onerror = (e) => ev.push('error ' + e.error.cause.code);
  ws.onclose = (e) => { ev.push('close ' + e.code + ' ' + JSON.stringify(e.reason) + ' ' + e.wasClean); resolve(path + ': ' + ev.join(', ')); };
  setTimeout(() => resolve(path + ': ' + ev.join(', ')), 1500);
});
server.listen(0, '127.0.0.1', async () => {
  for (const path of ['/masked', '/rsv', '/bigping', '/noconn', '/ext', '/drop', '/close']) console.log(await one(path));
  console.log('echoed', echoes.join(','));
  const ws = new WebSocket('ws://127.0.0.1:' + server.address().port + '/drop');
  for (const [code, reason] of [[999], [1001], [3000, 'x'.repeat(124)], [4999, 'x'.repeat(123)]]) {
    try { ws.close(code, reason); console.log('close', code, 'ok'); } catch (e) { console.log('close', code, e.name, e.message); }
  }
  server.close();
});
`
      );
      assert.deepEqual(await run(['node', 'strict.js']), {
        status: 0,
        stdout: [
          '/masked: open, close 1006 "" false',
          '/rsv: open, close 1006 "" false',
          '/bigping: open, close 1006 "" false',
          '/noconn: error EPROTO',
          '/ext: error EPROTO',
          '/drop: open, close 1006 "" false',
          '/close: open, close 4001 "bye" true',
          'echoed 8:4001',
          'close 999 InvalidAccessError invalid code',
          'close 1001 InvalidAccessError invalid code',
          'close 3000 SyntaxError Reason must be less than 123 bytes; received 124',
          'close 4999 ok',
          '',
        ].join('\n'),
        stderr: '',
      });
    } finally {
      close();
    }
  });

  // The client on host Node's net (the module needs only net.connect, WebCrypto and streams).
  it('frames that come after the reader cancelled are dropped, not thrown into the program', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => wss.on('listening', resolve));
    let peerClosed;
    const serverSaw = new Promise((resolve) => {
      peerClosed = resolve;
    });
    wss.on('connection', (peer) => {
      peer.on('close', (code) => peerClosed(code));
      peer.send('first');
      // A burst the program never reads: it cancelled after the first.
      peer.once('message', () => {
        for (let i = 0; i < 20; i++) peer.send(`late ${i}`);
      });
    });
    const uncaught = [];
    const onUncaught = (err) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      const { port } = wss.address();
      const socket = await openLoopbackWebSocket(net, `ws://127.0.0.1:${port}/`, undefined, { host: '127.0.0.1', port });
      const reader = socket.readable.getReader();
      assert.deepEqual(await reader.read(), { value: 'first', done: false });
      const writer = socket.writable.getWriter();
      await writer.write('go');
      await reader.cancel();
      assert.deepEqual(await socket.closed, { code: 1000, reason: '', wasClean: true });
      assert.equal(await serverSaw, 1000);
      assert.deepEqual(uncaught, []);
    } finally {
      process.off('uncaughtException', onUncaught);
      await new Promise((resolve) => wss.close(resolve));
    }
  });
});
