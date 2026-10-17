import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devPackageTree, withJsh } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const version = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

// http-proxy-agent rewrites req.path to the absolute URL and calls
// req._implicitHeader() to render the head again (ai-ecoverse/slicc-jsh#323).
describe('http-proxy-agent (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    for (const [path, data] of devPackageTree('http-proxy-agent')) await jsh.kernel.writeFile(`/os${path}`, data);
  });
  after(() => jsh?.close());

  it('the real http-proxy-agent sends GET and POST through a plain http proxy in absolute form', async () => {
    assert.equal(version('http-proxy-agent'), '9.1.0');
    await jsh.kernel.writeFile(
      '/os/proxied.js',
      `const http = require('http');
const { HttpProxyAgent } = require('http-proxy-agent');
const seen = [];
const origin = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => res.end('origin saw ' + req.method + ' ' + req.url + (body ? ' ' + body : '')));
});
// A forward proxy: the request line has the absolute URL; it asks the origin for it.
const proxy = http.createServer((req, res) => {
  seen.push(req.method + ' ' + req.url.replace(/:\\d+/, ':P') + ' proxy-connection=' + req.headers['proxy-connection']);
  const u = new URL(req.url);
  const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  req.pipe(up);
});
const send = (opts, body) => new Promise((resolve) => {
  const req = http.request(opts, (res) => {
    let b = '';
    res.on('data', (c) => (b += c));
    res.on('end', () => resolve(res.statusCode + ' ' + b));
  });
  req.on('error', (e) => resolve('error ' + e.code + ' ' + e.message));
  req.end(body);
});
origin.listen(0, '127.0.0.1', () => proxy.listen(0, '127.0.0.1', async () => {
  const agent = new HttpProxyAgent('http://127.0.0.1:' + proxy.address().port);
  const port = origin.address().port;
  console.log(await send({ host: '127.0.0.1', port, path: '/hello?x=1', agent }));
  console.log(await send({ host: '127.0.0.1', port, path: '/post', method: 'POST', agent, headers: { 'content-type': 'text/plain' } }, 'payload'));
  console.log('proxy saw', seen.join(' | '));
  origin.close();
  proxy.close();
}));
`
    );
    const r = await jsh.run(['node', 'proxied.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.split('\n'), [
      '200 origin saw GET /hello?x=1',
      '200 origin saw POST /post payload',
      'proxy saw GET http://127.0.0.1:P/hello?x=1 proxy-connection=close | POST http://127.0.0.1:P/post proxy-connection=close',
      '',
    ]);
  });

  it('_implicitHeader renders the head into _header, and throws once it is sent', async () => {
    const r = await jsh.run([
      'node',
      '-e',
      `const http = require('http');
const server = http.createServer((req, res) => res.end(req.url));
server.listen(0, '127.0.0.1', () => {
  const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/a', agent: false }, (res) => {
    res.resume();
    res.on('end', () => {
      console.log('after', JSON.stringify(req._header));
      try { req._implicitHeader(); } catch (e) { console.log(e.code, e.message); }
      server.close();
    });
  });
  console.log('before', req._header);
  req.path = '/b';
  req._implicitHeader();
  console.log('rendered', JSON.stringify(req._header));
  req._header = null;
  req.end();
});
`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const port = /127\.0\.0\.1:(\d+)/.exec(r.stdout)?.[1];
    assert.deepEqual(r.stdout.split('\n'), [
      'before null',
      `rendered "GET /b HTTP/1.1\\r\\nHost: 127.0.0.1:${port}\\r\\nConnection: close\\r\\n\\r\\n"`,
      `after "GET /b HTTP/1.1\\r\\nHost: 127.0.0.1:${port}\\r\\nConnection: close\\r\\n\\r\\n"`,
      'ERR_HTTP_HEADERS_SENT Cannot render headers after they are sent to the client',
      '',
    ]);
  });
});
