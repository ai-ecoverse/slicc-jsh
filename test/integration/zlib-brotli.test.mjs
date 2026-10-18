import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';
import { devPackageTree, withJsh } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const version = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

// The page a server in the kernel sends `content-encoding: br`, as the host's
// encoder made it (jsh has no Brotli encoder).
const page = `<!doctype html>\n<title>br</title>\n${'<p>Brotli over HTTP, decoded by a client in the kernel.</p>\n'.repeat(400)}`;
const pageBr = brotliCompressSync(page, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } });

// The server: `br` bodies, whole or in pieces a few milliseconds apart; it
// answers each request's Accept-Encoding in a header.
const server = `const http = require('http');
const fs = require('fs');
const br = fs.readFileSync('/os/page.br');
module.exports = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const headers = { 'content-encoding': 'br', 'content-type': 'text/html', 'x-accept-encoding': String(req.headers['accept-encoding']) };
    if (req.url === '/slow') {
      res.writeHead(200, headers);
      let at = 0;
      const next = () => {
        if (at >= br.length) return res.end();
        res.write(br.subarray(at, at + 700));
        at += 700;
        setTimeout(next, 5);
      };
      return next();
    }
    if (req.url === '/corrupt') {
      res.writeHead(200, headers);
      return res.end(Buffer.from('this is not brotli'));
    }
    res.writeHead(200, headers);
    res.end(br);
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});
`;

describe('zlib Brotli decompression (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    for (const name of ['got', 'axios']) {
      for (const [path, data] of devPackageTree(name)) await jsh.kernel.writeFile(`/os${path}`, data);
    }
    await jsh.kernel.writeFile('/os/page.br', pageBr);
    await jsh.kernel.writeFile('/os/server.cjs', server);
  });
  after(() => jsh?.close());

  it('the real got asks for br (process.versions.brotli) and decodes a br response, whole and streamed', async () => {
    assert.equal(version('got'), '16.1.0');
    await jsh.kernel.writeFile(
      '/os/got-br.mjs',
      `import got from 'got';
import start from './server.cjs';
const server = await start();
const base = 'http://127.0.0.1:' + server.address().port;
try {
  const res = await got(base + '/page');
  console.log('accept-encoding', res.headers['x-accept-encoding']);
  console.log('page', res.body.length, res.body.endsWith('kernel.</p>\\n'));
  const chunks = [];
  for await (const chunk of got.stream(base + '/slow')) chunks.push(chunk);
  console.log('stream', Buffer.concat(chunks).toString().length, chunks.length > 1);
  await got(base + '/corrupt').catch((e) => console.log('corrupt', e.name, e.code));
} catch (e) {
  console.log('error', e.code, e.message);
}
server.close();
`
    );
    const r = await jsh.run(['node', 'got-br.mjs']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.split('\n'), [
      'accept-encoding gzip, deflate, br, zstd',
      `page ${page.length} true`,
      `stream ${page.length} true`,
      'corrupt ReadError ERR_READING_RESPONSE_STREAM',
      '',
    ]);
  });

  // In Node the write is already on the thread pool when reset() is called,
  // so the reset nearly always comes after it (Node 22 races: a reset during
  // the work can also land first, or trip an assertion at exit). jsh decodes
  // at write(), so it always comes after.
  it('reset() right after an async write comes after that write', async () => {
    await jsh.kernel.writeFile('/os/first.br', brotliCompressSync('first.'));
    await jsh.kernel.writeFile('/os/second.br', brotliCompressSync('second.'));
    await jsh.kernel.writeFile(
      '/os/reset.cjs',
      `const fs = require('fs');
const zlib = require('zlib');
const d = zlib.createBrotliDecompress();
const out = [];
d.on('data', (c) => out.push(c));
d.on('error', (e) => console.log('error', e.code));
d.write(fs.readFileSync('/os/first.br'));
d.reset();
d.end(fs.readFileSync('/os/second.br'), () => console.log(Buffer.concat(out).toString()));
`
    );
    const r = await jsh.run(['node', 'reset.cjs']);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, 'first.second.\n');
  });

  it('the real axios asks for br and decodes a br response', async () => {
    assert.equal(version('axios'), '1.20.0');
    await jsh.kernel.writeFile(
      '/os/axios-br.cjs',
      `const axios = require('axios');
const start = require('./server.cjs');
start().then(async (server) => {
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const res = await axios.get(base + '/slow', { responseType: 'text' });
    console.log('accept-encoding', res.headers['x-accept-encoding']);
    console.log('page', res.data.length, res.data.endsWith('kernel.</p>\\n'));
  } catch (e) {
    console.log('error', e.code, e.message);
  }
  server.close();
});
`
    );
    const r = await jsh.run(['node', 'axios-br.cjs']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.split('\n'), [
      'accept-encoding gzip, compress, deflate, br',
      `page ${page.length} true`,
      '',
    ]);
  });
});
