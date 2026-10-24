/**
 * Keep-alive where the goldens can't follow: a client exits at once with
 * a free socket in globalAgent's pool (to a server in another process), and
 * headersTimeout's 408.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

describe('http keep-alive (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it('a client with an idle kept-alive socket ends as soon as its work is done', async () => {
    await jsh.kernel.writeFile(
      '/os/ka-server.js',
      "require('http').createServer((req, res) => res.end('hi ' + req.url)).listen(4711, '127.0.0.1', () => console.log('listening'));\n"
    );
    await jsh.kernel.writeFile(
      '/os/ka-client.js',
      [
        "const http = require('http');",
        "const get = (p) => new Promise((r, j) => http.get('http://127.0.0.1:4711' + p, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => r(`${b} ${res.headers.connection}`)); }).on('error', j));",
        "(async () => { console.log(await get('/1')); console.log(await get('/2')); console.log('free', Object.values(http.globalAgent.freeSockets).flat().length); })();",
      ].join('\n')
    );
    // Runs until the kernel ends (after()).
    jsh.run(['node', 'ka-server.js']).catch(() => {});
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      const probe = await jsh.run(['node', '-e', "require('net').connect(4711, '127.0.0.1').on('connect', function () { this.destroy(); process.exit(0); }).on('error', () => process.exit(1))"]);
      ready = probe.status === 0;
      if (!ready) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready, 'server up');
    const t = Date.now();
    const r = await jsh.run(['node', 'ka-client.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'hi /1 keep-alive\nhi /2 keep-alive\nfree 1\n');
    // Not held for the agent's 5 s free-socket timeout or the server's keepAliveTimeout.
    assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
  });

  it('headers that don\'t arrive within headersTimeout get 408 and the connection closes', async () => {
    const r = await jsh.run([
      'node',
      '-e',
      [
        "const http = require('http'); const net = require('net');",
        "const server = http.createServer({ connectionsCheckingInterval: 20 }, (req, res) => res.end('never'));",
        'server.headersTimeout = 200;',
        "server.listen(0, '127.0.0.1', () => {",
        "  const s = net.connect(server.address().port, '127.0.0.1', () => s.write('GET / HTTP/1.1\\r\\nHost: x\\r\\n'));",
        "  let b = ''; s.on('data', (d) => (b += d));",
        "  s.on('close', () => { console.log(JSON.stringify(b)); server.close(); });",
        '});',
      ].join('\n'),
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '"HTTP/1.1 408 Request Timeout\\r\\nConnection: close\\r\\n\\r\\n"\n');
  });

  it('headersTimeout covers the headers only (a slow body has requestTimeout), and a connection that sends nothing; close(cb) waits for a busy connection', async () => {
    const script = [
      "const http = require('http'); const net = require('net');",
      'const ev = [];',
      'const server = http.createServer({ connectionsCheckingInterval: 50 }, (req, res) => {',
      '  server.headersTimeout = 300; server.requestTimeout = 3000;',
      "  let b = ''; req.on('data', (d) => (b += d));",
      "  req.on('end', () => {",
      "    if (req.url === '/slowres') { setTimeout(() => { res.end('late'); ev.push('response sent'); }, 150); server.close(() => { ev.push('close cb'); console.log(ev.join(' | ')); }); return; }",
      "    res.end('body ' + b);",
      '  });',
      '});',
      "server.listen(0, '127.0.0.1', async () => {",
      '  const port = server.address().port;',
      "  const r = await new Promise((resolve) => { const s = net.connect(port, '127.0.0.1', () => { s.write('POST /slow HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: 4\\r\\nConnection: close\\r\\n\\r\\n'); setTimeout(() => s.write('data'), 500); }); let out = ''; s.on('data', (d) => (out += d)); s.on('close', () => resolve(out.split('\\r\\n')[0] + ' ' + out.split('\\r\\n\\r\\n')[1])); });",
      "  console.log('slow body:', r);",
      "  const silent = await new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); let out = ''; s.on('data', (d) => (out += d)); s.on('close', () => resolve(JSON.stringify(out))); setTimeout(() => { s.destroy(); resolve('still open'); }, 3000); });",
      "  console.log('silent connection:', silent);",
      "  http.get({ port, path: '/slowres', agent: false }, (res) => res.resume());",
      '});',
    ].join('\n');
    const r = await jsh.run(['node', '-e', script]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      'slow body: HTTP/1.1 200 OK body data\nsilent connection: "HTTP/1.1 408 Request Timeout\\r\\nConnection: close\\r\\n\\r\\n"\nresponse sent | close cb\n'
    );
  });

  it('#195: createServer({ headersTimeout, requestTimeout }) takes them (a partial request gets 408 before 3 s), and close(cb) waits for a slow request, which ends without an error', async () => {
    const script = [
      "const http = require('http'); const net = require('net');",
      'const t0 = Date.now();',
      'const ev = [];',
      "const server = http.createServer({ headersTimeout: 800, requestTimeout: 800, connectionsCheckingInterval: 50 }, (req, res) => {",
      "  if (req.url === '/slow') { server.close(() => ev.push('close cb')); setTimeout(() => res.end('slow done'), 300); } else res.end('ok');",
      '});',
      "console.log('options', server.headersTimeout, server.requestTimeout);",
      "server.listen(0, '127.0.0.1', async () => {",
      '  const port = server.address().port;',
      "  const r = await new Promise((resolve) => { const s = net.connect(port, '127.0.0.1', () => s.write('GET / HTTP/1.1\\r\\nHost: x\\r\\n')); let b = ''; s.on('data', (d) => (b += d)); s.on('close', () => resolve(b.split('\\r\\n')[0] + ' within 3 s: ' + (Date.now() - t0 < 3000))); });",
      "  console.log('partial request:', r);",
      "  http.get({ port, path: '/slow' }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => ev.push('end ' + b)); }).on('error', (e) => ev.push('client error ' + e.message));",
      '});',
      "process.on('exit', () => console.log(ev.join(' | ')));",
    ].join('\n');
    const r = await jsh.run(['node', '-e', script]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'options 800 800\npartial request: HTTP/1.1 408 Request Timeout within 3 s: true\nend slow done | close cb\n');
  });

  it('requestTimeout starts at the first byte, and a late res.end does not follow the 408', async () => {
    const script = [
      "const http = require('http'); const net = require('net');",
      'const seen = [];',
      'const server = http.createServer({ headersTimeout: 0, requestTimeout: 0, connectionsCheckingInterval: 10 }, (req, res) => {',
      '  server.requestTimeout = 40;',
      '  seen.push(req.url);',
      '  req.resume();',
      "  setTimeout(() => { try { res.end('LATE'); } catch { /* detached */ } }, 100);",
      '});',
      "server.listen(0, '127.0.0.1', () => {",
      '  const port = server.address().port;',
      "  const late = net.connect(port, '127.0.0.1', () => late.write('POST /a HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: 10\\r\\n\\r\\npart'));",
      "  let body = '';",
      "  late.on('data', (d) => (body += d));",
      "  late.on('close', () => {",
      "    const first = net.connect(port, '127.0.0.1', () => first.write('PO'));",
      "    let head = '';",
      "    const timer = setTimeout(() => { first.destroy(); finish('still open'); }, 200);",
      "    first.on('data', (d) => (head += d));",
      "    first.on('close', () => { clearTimeout(timer); finish(head.split('\\r\\n')[0]); });",
      '    function finish(stall) {',
      "      console.log(body.split('\\r\\n')[0]);",
      "      console.log(body.includes('LATE') ? 'LATE' : 'no late');",
      "      console.log('seen', seen.join(','));",
      "      console.log(stall);",
      '      server.close();',
      '    }',
      '  });',
      '});',
    ].join('\n');
    const r = await jsh.run(['node', '-e', script]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'HTTP/1.1 408 Request Timeout\nno late\nseen /a\nHTTP/1.1 408 Request Timeout\n');
  });

  it("#361: a request's 'error' with no listener ends the program (Node's unhandled 'error'), never a wait for a response that can't come", async () => {
    await jsh.kernel.writeFile(
      '/os/ka-dead.js',
      [
        "const http = require('http');",
        "const server = http.createServer((req, res) => res.end('ok'));",
        "server.listen(0, '127.0.0.1', () => {",
        '  const agent = new http.Agent({ keepAlive: true });',
        '  const port = server.address().port;',
        "  http.get({ host: '127.0.0.1', port, path: '/1', agent }, (res) => {",
        '    res.resume();',
        "    res.on('end', () => setImmediate(() => { server.closeIdleConnections(); http.get({ host: '127.0.0.1', port, path: '/2', agent }, () => console.log('a response')); }));",
        '  });',
        '});',
        '',
      ].join('\n')
    );
    let bound;
    const r = await Promise.race([
      jsh.run(['node', 'ka-dead.js'], { cwd: '/os' }),
      new Promise((resolve) => (bound = setTimeout(() => resolve({ status: 'still running after 60 s', stdout: '', stderr: '' }), 60_000))),
    ]);
    clearTimeout(bound);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^Error: socket hang up$/m);
  });
});
