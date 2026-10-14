/**
 * http.request's two ways out of the kernel:
 * - a route (the embedder's uplink): real TCP through ctx.net.connect, the
 *   bytes as sent, the response as received (fakeUplink here);
 * - no route (ENOENT / ENETUNREACH from the connect, before a byte went
 *   out): the same request through ctx.fetch, as https does (nodeTransport
 *   with hostLoopback, to a server on the host as host.slicc.internal);
 * and loopback, which is always the kernel's own.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createNodeKernel } from '@ai-ecoverse/slicc-kernel/node';
import { fakeUplink } from '@ai-ecoverse/slicc-kernel/testing';
import { packageFiles, withJsh } from './helpers.mjs';

const program = (lines) => `(async () => {\n${lines.join('\n')}\n})().catch((e) => { console.error(e); process.exit(1); });\n`;
const GET = [
  "const http = require('http');",
  'const get = (url, opts = {}, body) => new Promise((resolve) => {',
  '  const req = http.request(url, opts, (res) => {',
  "    let b = ''; let chunks = 0;",
  "    res.on('data', (d) => { b += d; chunks++; });",
  "    res.on('end', () => resolve({ status: res.statusCode, message: res.statusMessage, raw: res.rawHeaders, headers: res.headers, body: b, chunks, socket: res.socket === null ? 'null' : typeof res.socket }));",
  '  });',
  "  req.on('error', (e) => resolve({ error: `${e.code} ${e.syscall} ${e.message}` }));",
  '  req.end(body);',
  '});',
];

describe('http.request through the uplink (a route: real TCP)', () => {
  let kernel;
  let uplink;
  const enc = new TextEncoder();
  before(async () => {
    uplink = fakeUplink({
      names: { 'routed.test': ['93.184.0.1'] },
      routes: { prefixes: ['93.184.0.0/16'] },
      peers: {
        '93.184.0.1:80': async (srv) => {
          let req = '';
          for (;;) {
            const b = await srv.read();
            if (!b) break;
            req += new TextDecoder().decode(b);
            if (req.includes('\r\n\r\n')) break;
          }
          const line = req.split('\r\n')[0];
          const host = /\r\nhost: ([^\r]*)/i.exec(req)?.[1];
          const body = `${line} host=${host}`;
          srv.write(enc.encode(`HTTP/1.1 200 Fine\r\nX-Mixed-Case: yes\r\nContent-Length: ${body.length}\r\n\r\n${body}`));
          srv.end();
        },
      },
    });
    kernel = await createNodeKernel({ network: { uplink } });
    for (const [rel, data] of packageFiles()) await kernel.writeFile(`/node_modules/@ai-ecoverse/slicc-jsh/${rel}`, data);
  });
  after(() => kernel?.terminate());

  it('dials, sends the request line and Host as given, and keeps the reason phrase and header case', async () => {
    await kernel.writeFile(
      '/os/tcp.js',
      program([...GET, "const r = await get('http://routed.test/p?q=1', { headers: { Host: 'virtual.example' } });", 'console.log(JSON.stringify(r));'])
    );
    const r = await kernel.run(['node', 'tcp.js'], { cwd: '/os' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, 200);
    assert.equal(out.message, 'Fine');
    assert.equal(out.body, 'GET /p?q=1 HTTP/1.1 host=virtual.example');
    assert.ok(out.raw.includes('X-Mixed-Case'), JSON.stringify(out.raw));
    assert.notEqual(out.socket, 'null');
    assert.deepEqual(uplink.dialled.map((d) => `${d.host}:${d.port}`), ['93.184.0.1:80']);
  });

  it('an address outside the routes falls back to fetch, which has no network here: Node’s connect error', async () => {
    await kernel.writeFile('/os/unrouted.js', program([...GET, "console.log((await get('http://10.9.8.7:8080/')).error);"]));
    const r = await kernel.run(['node', 'unrouted.js'], { cwd: '/os' });
    assert.equal(r.stdout, 'ENETUNREACH connect connect ENETUNREACH 10.9.8.7:8080\n', r.stderr);
  });
});

describe('http.request without a route: through ctx.fetch', () => {
  let server;
  let port;
  let jsh;
  const seen = [];
  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body, headers: req.headers });
        if (req.url === '/stream') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.write('one ');
          setTimeout(() => res.end('two'), 50);
          return;
        }
        if (req.url === '/redirect') {
          res.writeHead(302, { Location: '/elsewhere' });
          res.end();
          return;
        }
        res.writeHead(201, { 'X-Echo': req.headers['x-custom'] ?? '', 'Set-Cookie': ['a=1', 'b=2'] });
        res.end(`${req.method} ${req.url} ${body}`);
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    jsh = await withJsh({ hostLoopback: true });
  });
  after(async () => {
    jsh?.close();
    await new Promise((r) => server.close(r));
  });

  it('GET and POST with headers, a body, set-cookie as an array, a streamed body, a 302 as it is', async () => {
    const base = `http://host.slicc.internal:${port}`;
    await jsh.kernel.writeFile(
      '/os/viafetch.js',
      program([
        ...GET,
        `const a = await get('${base}/a?x=1', { headers: { 'X-Custom': 'hi' } });`,
        "if (a.error) console.log(a.error);",
        "console.log(a.status, a.message, a.headers['x-echo'], JSON.stringify(a.headers['set-cookie']), JSON.stringify(a.body), a.socket);",
        `const b = await get('${base}/post', { method: 'POST', headers: { 'Content-Type': 'text/plain' } }, 'payload');`,
        'console.log(b.status, JSON.stringify(b.body));',
        `const c = await get('${base}/stream');`,
        'console.log(c.status, JSON.stringify(c.body), c.chunks >= 1);',
        `const d = await get('${base}/redirect');`,
        "console.log(d.status, d.headers.location);",
      ])
    );
    const r = await jsh.run(['node', 'viafetch.js']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(
      r.stdout,
      [
        '201 Created hi ["a=1","b=2"] "GET /a?x=1 " null',
        '201 "POST /post payload"',
        '200 "one two" true',
        '302 /elsewhere',
        '',
      ].join('\n')
    );
    assert.equal(seen[0].headers['x-custom'], 'hi');
    assert.equal(seen[1].headers['content-type'], 'text/plain');
  });

  it('req.destroy() before the response aborts the fetch; a custom agent gets the connect error', async () => {
    const base = `http://host.slicc.internal:${port}`;
    await jsh.kernel.writeFile(
      '/os/viafetch2.js',
      program([
        "const http = require('http');",
        `const req = http.get('${base}/stream', () => console.log('response'));`,
        "req.on('error', (e) => console.log('error', e.code));",
        "req.on('close', () => console.log('closed'));",
        'req.destroy();',
        'await new Promise((r) => setTimeout(r, 200));',
        'class Proxy extends http.Agent {}',
        `await new Promise((r) => http.get('${base}/a', { agent: new Proxy() }, () => { console.log('agent response'); r(); }).on('error', (e) => { console.log('agent', e.code, e.syscall); r(); }));`,
      ])
    );
    const r = await jsh.run(['node', 'viafetch2.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'closed\nagent ENETUNREACH connect\n');
  });
});

describe('http.request without a route: ctx.fetch hands it to the embedder’s transport', () => {
  let kernel;
  const seen = [];
  before(async () => {
    const enc = new TextEncoder();
    const transport = {
      traits: { manualRedirects: true, encodedBodies: false, crossOrigin: 'any' },
      async fetch(req) {
        seen.push({ url: req.url, method: req.method, headers: req.headers, body: req.body && new TextDecoder().decode(req.body) });
        if (req.url.endsWith('/slow')) {
          return {
            status: 200,
            statusText: 'OK',
            headers: [['content-type', 'text/plain']],
            body: (async function* () {
              yield enc.encode('first ');
              await new Promise((r) => setTimeout(r, 300));
              yield enc.encode('later');
            })(),
            cancel() {},
          };
        }
        return {
          status: 201,
          statusText: '',
          headers: [['content-type', 'text/plain'], ['set-cookie', 'a=1'], ['set-cookie', 'b=2']],
          body: (async function* () {
            yield enc.encode('from ');
            yield enc.encode('transport');
          })(),
          cancel() {},
        };
      },
    };
    kernel = await createNodeKernel({ network: { transport } });
    for (const [rel, data] of packageFiles()) await kernel.writeFile(`/node_modules/@ai-ecoverse/slicc-jsh/${rel}`, data);
  });
  after(() => kernel?.terminate());

  it('a name the kernel can’t resolve: method, path, headers and body reach the transport; the reason phrase is Node’s', async () => {
    await kernel.writeFile(
      '/os/transport.js',
      program([
        ...GET,
        "const r = await get('http://far.example:8080/path?q', { method: 'POST', headers: { 'X-A': '1', Connection: 'keep-alive' } }, 'body!');",
        "console.log(r.status, r.message, JSON.stringify(r.headers), r.body, r.socket);",
      ])
    );
    const r = await kernel.run(['node', 'transport.js'], { cwd: '/os' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, '201 Created {"content-type":"text/plain","set-cookie":["a=1","b=2"]} from transport null\n');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'http://far.example:8080/path?q');
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].body, 'body!');
    assert.deepEqual(seen[0].headers.filter(([k]) => k === 'x-a' || k === 'connection'), [['x-a', '1']]);
  });

  it('a streamed https body that pauses keeps the program alive to its end', async () => {
    await kernel.writeFile(
      '/os/slow.js',
      program([
        "const https = require('https');",
        "await new Promise((resolve) => https.get('https://far.example/slow', (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { console.log('https', JSON.stringify(b)); resolve(); }); }));",
        "await new Promise((resolve) => require('http').get('http://far.example/slow', (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { console.log('http', JSON.stringify(b)); resolve(); }); }));",
      ])
    );
    const r = await kernel.run(['node', 'slow.js'], { cwd: '/os' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, 'https "first later"\nhttp "first later"\n');
  });

  it('what fetch can’t send is refused, not changed: a GET body, TRACE; a proxy-like agent gets the connect error, a plain Agent the fallback', async () => {
    const before = seen.length;
    await kernel.writeFile(
      '/os/refused.js',
      program([
        ...GET,
        "console.log((await get('http://far.example/g', {}, 'a body')).error);",
        "console.log((await get('http://far.example/t', { method: 'TRACE' })).error);",
        "const proxied = new http.Agent(); proxied.createConnection = (o, cb) => require('net').createConnection(o, cb);",
        "console.log((await get('http://far.example/p', { agent: proxied })).error);",
        "console.log((await get('http://far.example/k', { agent: new http.Agent({ keepAlive: true }) })).status);",
      ])
    );
    const r = await kernel.run(['node', 'refused.js'], { cwd: '/os' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(
      r.stdout,
      [
        "ERR_NOT_SUPPORTED undefined slicc-jsh: a GET request with a body can't go through fetch (no route to far.example in the kernel)",
        "ERR_NOT_SUPPORTED undefined slicc-jsh: a TRACE request can't go through fetch (no route to far.example in the kernel)",
        'ENOTFOUND getaddrinfo getaddrinfo ENOTFOUND far.example',
        '201',
        '',
      ].join('\n')
    );
    assert.deepEqual(seen.slice(before).map((x) => x.url), ['http://far.example/k']);
  });
});

describe('http.request on loopback stays the kernel’s own', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it('a jsh server on 127.0.0.1 and localhost: raw sockets', async () => {
    await jsh.kernel.writeFile(
      '/os/loop.js',
      program([
        ...GET,
        "const srv = http.createServer((req, res) => { res.setHeader('X-Mixed-Case', 'yes'); res.end('loop ' + req.url); });",
        'await new Promise((r) => srv.listen(0, r));',
        'const p = srv.address().port;',
        "for (const h of ['127.0.0.1', 'localhost']) { const r = await get(`http://${h}:${p}/z`); console.log(h, r.status, r.body, r.headers['x-mixed-case'], r.socket); }",
        'srv.close();',
      ])
    );
    const r = await jsh.run(['node', 'loop.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '127.0.0.1 200 loop /z yes object\nlocalhost 200 loop /z yes object\n');
  });
});
