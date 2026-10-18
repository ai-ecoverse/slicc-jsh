import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, zstdCompressSync } from 'node:zlib';
import { devPackageTree, withJsh } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const version = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

// The page a server in the kernel sends `content-encoding: zstd`, as the
// host's encoder made it (jsh has no zstd encoder).
let seed = 1;
const token = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8).toString(36);
const lines = Array.from({ length: 400 }, () => `<p>${token()}: Zstandard over HTTP, decoded by a client in the kernel.</p>\n`);
const page = `<!doctype html>\n<title>zstd</title>\n${lines.join('')}`;
const pageZst = zstdCompressSync(page, { params: { [constants.ZSTD_c_compressionLevel]: 3, [constants.ZSTD_c_checksumFlag]: 1 } });

// The server: `zstd` bodies, whole or in pieces a few milliseconds apart; it
// answers each request's Accept-Encoding in a header.
const server = `const http = require('http');
const fs = require('fs');
const zst = fs.readFileSync('/os/page.zst');
module.exports = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const headers = { 'content-encoding': 'zstd', 'content-type': 'text/html', 'x-accept-encoding': String(req.headers['accept-encoding']) };
    if (req.url === '/slow') {
      res.writeHead(200, headers);
      let at = 0;
      const next = () => {
        if (at >= zst.length) return res.end();
        res.write(zst.subarray(at, at + 700));
        at += 700;
        setTimeout(next, 5);
      };
      return next();
    }
    if (req.url === '/corrupt') {
      res.writeHead(200, headers);
      return res.end(Buffer.from('this is not zstd'));
    }
    res.writeHead(200, headers);
    res.end(zst);
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});
`;

describe('zlib zstd decompression (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    for (const name of ['got', 'axios']) {
      for (const [path, data] of devPackageTree(name)) await jsh.kernel.writeFile(`/os${path}`, data);
    }
    await jsh.kernel.writeFile('/os/page.zst', pageZst);
    await jsh.kernel.writeFile('/os/server.cjs', server);
  });
  after(() => jsh?.close());

  it('the real got asks for zstd (process.versions.zstd) and decodes a zstd response, whole and streamed', async () => {
    assert.equal(version('got'), '16.1.0');
    assert.ok(pageZst.length > 1400, 'the streamed body comes in several pieces');
    await jsh.kernel.writeFile(
      '/os/got-zstd.mjs',
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
  console.log('stream', Buffer.concat(chunks).toString() === res.body);
  await got(base + '/corrupt').catch((e) => console.log('corrupt', e.name, e.code));
} catch (e) {
  console.log('error', e.code, e.message);
}
server.close();
`
    );
    const r = await jsh.run(['node', 'got-zstd.mjs']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.split('\n'), [
      'accept-encoding gzip, deflate, br, zstd',
      `page ${page.length} true`,
      'stream true',
      'corrupt ReadError ERR_READING_RESPONSE_STREAM',
      '',
    ]);
  });

  it('the real axios decodes a zstd response, unasked and with advertiseZstdAcceptEncoding', async () => {
    assert.equal(version('axios'), '1.20.0');
    await jsh.kernel.writeFile(
      '/os/axios-zstd.cjs',
      `const axios = require('axios');
const start = require('./server.cjs');
start().then(async (server) => {
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const transitional of [undefined, { advertiseZstdAcceptEncoding: true }]) {
    try {
      const res = await axios.get(base + '/slow', { responseType: 'text', transitional });
      console.log('accept-encoding', res.headers['x-accept-encoding']);
      console.log('page', res.data.length, res.data.endsWith('kernel.</p>\\n'));
    } catch (e) {
      console.log('error', e.code, e.message);
    }
  }
  await axios.get(base + '/corrupt').catch((e) => console.log('corrupt', e.code));
  server.close();
});
`
    );
    const r = await jsh.run(['node', 'axios-zstd.cjs']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.split('\n'), [
      'accept-encoding gzip, compress, deflate, br',
      `page ${page.length} true`,
      'accept-encoding gzip, compress, deflate, br, zstd',
      `page ${page.length} true`,
      'corrupt ZSTD_error_prefix_unknown',
      '',
    ]);
  });
});
