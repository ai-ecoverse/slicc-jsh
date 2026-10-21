import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { brotliDecompressSync, zstdDecompressSync } from 'node:zlib';
import { node22Bin, node22Env } from '../../scripts/node22.mjs';
import { devPackageTree, withJsh } from './helpers.mjs';

let seed = 7;
const token = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8).toString(36);
const lines = Array.from({ length: 600 }, () => `<p>${token()}: compressed by a server in the kernel, decoded by got.</p>\n`);
const pieces = [];
for (let i = 0; i < lines.length; i += 50) pieces.push(lines.slice(i, i + 50).join(''));
const page = pieces.join('');

const encoders = {
  br: `zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } })`,
  zstd: `zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 7, [zlib.constants.ZSTD_c_checksumFlag]: 1 } })`,
};
const server = `const http = require('http');
const fs = require('fs');
const zlib = require('zlib');
const pieces = ${JSON.stringify(pieces)};
module.exports = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const encoding = req.url.slice(1);
    const z = encoding === 'br' ? ${encoders.br} : ${encoders.zstd};
    const sent = [];
    z.on('data', (chunk) => sent.push(chunk));
    z.on('end', () => fs.writeFileSync('/os/sent.' + encoding, Buffer.concat(sent)));
    res.writeHead(200, { 'content-encoding': encoding, 'content-type': 'text/html', 'x-accept-encoding': String(req.headers['accept-encoding']) });
    z.pipe(res);
    let at = 0;
    const next = () => {
      if (at === pieces.length) return z.end();
      z.write(pieces[at++]);
      z.flush(() => setTimeout(next, 2));
    };
    next();
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});
`;

const node22Stream = (encoder) => {
  const script = `const zlib = require('zlib');
const pieces = ${JSON.stringify(pieces)};
const z = ${encoder};
const out = [];
z.on('data', (chunk) => out.push(chunk));
z.on('end', () => process.stdout.write(Buffer.concat(out).toString('base64')));
let at = 0;
const next = () => {
  if (at === pieces.length) return z.end();
  z.write(pieces[at++]);
  z.flush(next);
};
next();
`;
  const r = spawnSync(node22Bin(), ['-e', script], { encoding: 'utf8', env: node22Env(), timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return Buffer.from(r.stdout, 'base64');
};

describe('zlib Brotli and Zstd compression (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    for (const [path, data] of devPackageTree('got')) await jsh.kernel.writeFile(`/os${path}`, data);
    await jsh.kernel.writeFile('/os/server.cjs', server);
  });
  after(() => jsh?.close());

  it('a server streams br and zstd with flushes, got decodes them, and they are the bytes Node sends', async () => {
    await jsh.kernel.writeFile(
      '/os/got-compress.mjs',
      `import got from 'got';
import start from './server.cjs';
const server = await start();
const base = 'http://127.0.0.1:' + server.address().port;
for (const encoding of ['br', 'zstd']) {
  try {
    const chunks = [];
    for await (const chunk of got.stream(base + '/' + encoding, { headers: { 'accept-encoding': encoding } })) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    console.log(encoding, body.length, body.endsWith('decoded by got.</p>\\n'));
  } catch (e) {
    console.log('error', encoding, e.code, e.message);
  }
}
server.close();
`
    );
    const r = await jsh.run(['node', 'got-compress.mjs']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.split('\n'), [`br ${page.length} true`, `zstd ${page.length} true`, '']);

    const sentBr = Buffer.from(await jsh.kernel.readFile('/os/sent.br'));
    const sentZstd = Buffer.from(await jsh.kernel.readFile('/os/sent.zstd'));
    assert.equal(brotliDecompressSync(sentBr).toString(), page);
    assert.equal(zstdDecompressSync(sentZstd).toString(), page);
    const nodeBr = node22Stream(encoders.br);
    const nodeZstd = node22Stream(encoders.zstd);
    assert.ok(sentBr.equals(nodeBr), 'the Brotli stream is the bytes Node 22 writes');
    assert.ok(sentZstd.equals(nodeZstd), 'the Zstd stream is the bytes Node 22 writes');
  });
});
