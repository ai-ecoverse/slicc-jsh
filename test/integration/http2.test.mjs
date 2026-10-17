import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devPackageTree, withJsh } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const version = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

// axios and the AWS SDK's @smithy/node-http-handler require http2 at load and
// use it only behind an option. The golden http2-node22 pins the module's
// surface against Node; here the real packages run in a kernel program.
describe('http2 (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    for (const name of ['axios', '@smithy/node-http-handler']) {
      for (const [path, data] of devPackageTree(name)) await jsh.kernel.writeFile(`/os${path}`, data);
    }
  });
  after(() => jsh?.close());

  const server = `const http = require('http');
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ method: req.method, url: req.url, h: req.headers['x-h'] || null }));
});`;

  it('the real axios loads and GETs and POSTs over http to a loopback server', async () => {
    assert.equal(version('axios'), '1.20.0');
    await jsh.kernel.writeFile(
      '/os/axios-get.js',
      `${server}
const axios = require('axios');
server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const a = await axios.get(base + '/a?x=1', { headers: { 'x-h': 'one' } });
    console.log('get', a.status, JSON.stringify(a.data));
    const b = await axios.post(base + '/b', { k: 'v' });
    console.log('post', b.status, JSON.stringify(b.data));
    await axios.get(base + '/c', { httpVersion: 2 }).catch((e) => console.log('http2', e.code, e.message));
  } catch (e) {
    console.log('error', e.code, e.message);
  }
  server.close();
});
`
    );
    const r = await jsh.run(['node', 'axios-get.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.split('\n'), [
      'get 200 {"method":"GET","url":"/a?x=1","h":"one"}',
      'post 200 {"method":"POST","url":"/b","h":null}',
      "http2 ERR_NOT_SUPPORTED slicc-jsh: 'http2.connect' is not supported yet (no HTTP/2 sessions)",
      '',
    ]);
  });

  it("the real @smithy/node-http-handler (the AWS SDK v3's) loads, and its NodeHttpHandler sends a request", async () => {
    assert.equal(version('@smithy/node-http-handler'), '4.12.1');
    await jsh.kernel.writeFile(
      '/os/smithy.js',
      `${server}
const { NodeHttpHandler, NodeHttp2Handler } = require('@smithy/node-http-handler');
const { HttpRequest } = require('@smithy/core/protocols');
server.listen(0, '127.0.0.1', async () => {
  const handler = new NodeHttpHandler();
  try {
    const { response } = await handler.handle(new HttpRequest({ protocol: 'http:', hostname: '127.0.0.1', port: server.address().port, method: 'PUT', path: '/obj', query: { q: '1' }, headers: { 'x-h': 'two' }, body: 'data' }));
    let body = '';
    for await (const chunk of response.body) body += chunk;
    console.log('handle', response.statusCode, body);
  } catch (e) {
    console.log('error', e.code, e.message);
  }
  console.log('http2 handler', typeof NodeHttp2Handler);
  handler.destroy();
  server.close();
});
`
    );
    const r = await jsh.run(['node', 'smithy.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.split('\n'), [
      'handle 200 {"method":"PUT","url":"/obj?q=1","h":"two"}',
      'http2 handler function',
      '',
    ]);
  });

  it('http2.connect and a server listen throw ERR_NOT_SUPPORTED when called', async () => {
    const r = await jsh.run([
      'node',
      '-e',
      `const http2 = require('http2');
const t = (label, f) => { try { f(); console.log(label, 'no throw'); } catch (e) { console.log(label, e.code, e.message); } };
t('connect http', () => http2.connect('http://127.0.0.1:1'));
t('connect https', () => http2.connect('https://example.com'));
t('listen', () => http2.createServer().listen(0));
t('secure listen', () => http2.createSecureServer().listen(0));
t('performServerHandshake', () => http2.performServerHandshake(null));
`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split('\n'), [
      "connect http ERR_NOT_SUPPORTED slicc-jsh: 'http2.connect' is not supported yet (no HTTP/2 sessions)",
      "connect https ERR_NOT_SUPPORTED slicc-jsh: 'http2.connect' is not supported yet (no TLS on ctx.net)",
      "listen ERR_NOT_SUPPORTED slicc-jsh: 'http2.Server.listen' is not supported yet (no HTTP/2 sessions)",
      "secure listen ERR_NOT_SUPPORTED slicc-jsh: 'http2.Http2SecureServer.listen' is not supported yet (no TLS on ctx.net)",
      "performServerHandshake ERR_NOT_SUPPORTED slicc-jsh: 'http2.performServerHandshake' is not supported yet (no HTTP/2 sessions)",
      '',
    ]);
  });
});
