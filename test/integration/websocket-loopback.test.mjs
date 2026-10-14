/**
 * WebSocket to a loopback URL reaches a server of this kernel (as fetch
 * does), here the kernel's CDP facade on 127.0.0.1:9222 behind
 * SLICC_CDP_URL: ctx.websocket would go to the transport instead (the
 * host's 9222 on the Node entry, ENOTSUP in a page). ai-ecoverse/slicc-jsh#73.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeKernel } from '@ai-ecoverse/slicc-kernel/node';
import { packageFiles } from './helpers.mjs';

async function withCdp(answer) {
  const opened = [];
  const kernel = await createNodeKernel({
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

describe('WebSocket to the kernel loopback', () => {
  it('reaches the CDP facade at SLICC_CDP_URL: commands, a 70 kB answer, events, a clean close', async () => {
    const { kernel, opened, run, close } = await withCdp(echo);
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
    const { kernel, run, close } = await withCdp(echo);
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
    const { kernel, run, close } = await withCdp(echo);
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
    const kernel = await createNodeKernel();
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
        stdout: 'error EPROTO the server answered the upgrade with 503\n',
        stderr: '',
      });
    } finally {
      kernel.terminate();
    }
  });
});
