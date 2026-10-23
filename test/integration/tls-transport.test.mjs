import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { devPackageFiles, withJsh } from './helpers.mjs';

// From slicc-kernel 1.116.0 (ai-ecoverse/slicc-kernel#923) ctx.net.connect's
// `tls` carries HTTP/1.1 and WebSocket over TLS through the embedder's
// transport, which does the handshake. The kernel here gets a transport of
// the test's own: what it is asked is what a TLS peer would have been sent.
// From 1.124.0 the kernel has a handshake of its own for a host its uplink
// routes (tls-kernel.test.mjs); without an uplink, as here, it's the transport.

function recordingTransport() {
  const seen = [];
  const transport = {
    traits: { manualRedirects: true, encodedBodies: false, maxRequestBody: 1 << 20, websocket: true, streamingBodies: true },
    async fetch(req) {
      let body = '';
      if (req.body) body = Buffer.from(req.body).toString();
      if (req.bodyStream) for await (const chunk of req.bodyStream) body += Buffer.from(chunk).toString();
      const header = (name) => req.headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
      seen.push(`fetch ${req.method} ${req.url} ${body} x-h=${header('x-h')}`);
      const text = JSON.stringify({ method: req.method, url: req.url, body });
      return {
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'application/json'], ['X-Served-By', 'transport']],
        body: (async function* () {
          yield new TextEncoder().encode(text);
        })(),
        cancel: async () => {},
      };
    },
    async websocket(req) {
      seen.push(`websocket ${req.url} ${JSON.stringify(req.protocols)}`);
      const queue = [];
      let wake;
      let closed = false;
      let settle;
      return {
        protocol: req.protocols[0] ?? '',
        buffered: 0,
        send(data) {
          queue.push(typeof data === 'string' ? `echo ${data}` : data);
          wake?.();
        },
        messages: (async function* () {
          for (;;) {
            while (queue.length) yield queue.shift();
            if (closed) return;
            await new Promise((resolve) => (wake = resolve));
          }
        })(),
        close(code = 1000, reason = '') {
          closed = true;
          wake?.();
          settle({ code, reason, wasClean: true });
        },
        closed: new Promise((resolve) => (settle = resolve)),
      };
    },
  };
  return { transport, seen };
}

describe('tls over the kernel transport (kernel)', () => {
  let jsh;
  let seen;
  before(async () => {
    const t = recordingTransport();
    seen = t.seen;
    jsh = await withJsh({ transport: t.transport });
    for (const [path, data] of devPackageFiles('ws')) await jsh.kernel.writeFile(`/os${path}`, data);
  });
  after(() => jsh?.close());

  it('tls.connect: secureConnect with the session the kernel reports, then HTTP/1.1 over it', async () => {
    seen.length = 0;
    const r = await jsh.run([
      'node',
      '-e',
      `const tls = require('tls');
const s = tls.connect(443, 'example.test', { ALPNProtocols: ['http/1.1'] }, () => {
  console.log('secureConnect', s.authorized, s.authorizationError, s.alpnProtocol, s.servername, s.encrypted, JSON.stringify(s.getPeerCertificate()));
  s.write('GET /hello?x=1 HTTP/1.1\\r\\nHost: example.test\\r\\nX-H: one\\r\\nConnection: close\\r\\n\\r\\n');
});
s.on('connect', () => console.log('connect'));
let data = '';
s.setEncoding('utf8');
s.on('data', (c) => (data += c));
s.on('end', () => console.log('status line', data.split('\\r\\n')[0], data.includes('"url":"https://example.test/hello?x=1"')));
s.on('error', (e) => console.log('error', e.code, e.message));
`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split('\n'), [
      'connect',
      // Node's servername is the SNI it was given (none here: false); before
      // 1.124.0 jsh said the transport's name.
      `secureConnect true null http/1.1 false true {}`,
      'status line HTTP/1.1 200 OK true',
      '',
    ]);
    assert.deepEqual(seen, ['fetch GET https://example.test/hello?x=1  x-h=one']);
  });

  it('https.request with an https.Agent goes over a TLS socket, keep-alive reusing it', async () => {
    seen.length = 0;
    const r = await jsh.run([
      'node',
      '-e',
      `const https = require('https');
const agent = new https.Agent({ keepAlive: true });
const send = (path, body) => new Promise((resolve) => {
  const req = https.request({ host: 'api.example.test', path, method: body ? 'POST' : 'GET', agent, headers: { 'x-h': 'two' } }, (res) => {
    let b = '';
    const encrypted = res.socket.encrypted;
    res.on('data', (c) => (b += c));
    res.on('end', () => resolve([res.statusCode, res.rawHeaders.slice(0, 4).join(','), JSON.parse(b).url, encrypted, req.reusedSocket].join(' ')));
  });
  req.on('error', (e) => resolve('error ' + e.code + ' ' + e.message));
  req.end(body);
});
(async () => {
  console.log(await send('/a', 'payload'));
  console.log(await send('/b'));
  console.log('agent', agent.defaultPort, agent.protocol, Object.keys(agent.freeSockets).length);
  agent.destroy();
})();
`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split('\n'), [
      '200 content-type,application/json,X-Served-By,transport https://api.example.test/a true false',
      '200 content-type,application/json,X-Served-By,transport https://api.example.test/b true true',
      'agent 443 https: 1',
      '',
    ]);
    assert.deepEqual(seen, ['fetch POST https://api.example.test/a payload x-h=two', 'fetch GET https://api.example.test/b  x-h=two']);
  });

  it("the real ws's wss:// client opens, echoes and closes through the kernel's transport", async () => {
    seen.length = 0;
    const r = await jsh.run([
      'node',
      '-e',
      `const WebSocket = require('ws');
const ws = new WebSocket('wss://echo.example.test/sock', ['chat']);
ws.on('open', () => { console.log('open', ws.protocol); ws.send('hi'); });
ws.on('message', (m) => { console.log('message', String(m)); ws.close(1000, 'bye'); });
ws.on('close', (code, reason) => console.log('close', code, String(reason)));
ws.on('error', (e) => console.log('error', e.message));
`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split('\n'), ['open chat', 'message echo hi', 'close 1000 bye', '']);
    assert.deepEqual(seen, ['websocket wss://echo.example.test/sock ["chat"]']);
  });

  it("without an uplink route, what the transport won't carry fails with ERR_NOT_SUPPORTED: another protocol's port, h2 only, a custom ca, TLS over a loopback socket for another host; a closed loopback port is Node's ECONNREFUSED", async () => {
    const r = await jsh.run([
      'node',
      '-e',
      `const tls = require('tls');
const net = require('net');
const tryConnect = (label, opts) => new Promise((resolve) => {
  const s = tls.connect(opts, () => { console.log(label, 'connected'); s.destroy(); resolve(); });
  s.on('error', (e) => { console.log(label, e.code, e.message); resolve(); });
});
(async () => {
  await tryConnect('imaps', { host: 'mail.example.test', port: 993 });
  await tryConnect('h2 only', { host: 'example.test', port: 443, ALPNProtocols: ['h2'] });
  await tryConnect('ca', { host: 'example.test', port: 443, ca: '-----BEGIN CERTIFICATE-----\\nMA==\\n-----END CERTIFICATE-----\\n' });
  await tryConnect('loopback', { host: '127.0.0.1', port: 443 });
  const server = net.createServer((c) => c.on('data', () => {})).listen(0, '127.0.0.1', async () => {
    const plain = net.connect(server.address().port, '127.0.0.1', async () => {
      await tryConnect('loopback socket', { socket: plain, servername: 'example.test' });
      console.log('plain destroyed', plain.destroyed);
      server.close();
    });
  });
})();
`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split('\n'), [
      "imaps ERR_NOT_SUPPORTED slicc-jsh: 'tls.connect to mail.example.test:993' is not supported yet (the kernel's TLS to a host its uplink doesn't route goes through its transport, which carries HTTP/1.1 and WebSocket only)",
      "h2 only ERR_NOT_SUPPORTED slicc-jsh: 'tls.connect to example.test:443' is not supported yet (the kernel's TLS to a host its uplink doesn't route goes through its transport, which carries HTTP/1.1 and WebSocket only)",
      "ca ERR_NOT_SUPPORTED slicc-jsh: 'tls.connect to example.test:443' is not supported yet (a custom ca needs a host the kernel's uplink routes)",
      'loopback ECONNREFUSED connect ECONNREFUSED 127.0.0.1:443',
      "loopback socket ERR_NOT_SUPPORTED slicc-jsh: 'tls.connect over a socket' is not supported yet (the kernel upgrades only a plain connection its uplink routes)",
      'plain destroyed true',
      '',
    ]);
  });
});
