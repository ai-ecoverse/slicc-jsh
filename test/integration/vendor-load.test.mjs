import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeKernel, nodeTransport } from '@ai-ecoverse/slicc-kernel/node';
import { devPackageFiles, packageFiles } from './helpers.mjs';

const ROOT = '/opt/app/node_modules';
const STORE = `${ROOT}/.pnpm/@ai-ecoverse+slicc-jsh@0.0.0/node_modules/@ai-ecoverse/slicc-jsh`;
const LINK = `${ROOT}/@ai-ecoverse/slicc-jsh`;

const USES = `
const zlib = require('zlib');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const s = 'vendor '.repeat(50);
console.log(
  require('fs').existsSync('/node_modules/@ai-ecoverse/slicc-jsh'),
  zlib.gunzipSync(zlib.gzipSync(s)).toString() === s,
  zlib.brotliDecompressSync(zlib.brotliCompressSync(s)).toString() === s,
  zlib.zstdDecompressSync(zlib.zstdCompressSync(s)).toString() === s,
  crypto.createHash('sha256').update(s).digest('hex').slice(0, 8),
  crypto.createCipheriv('aes-128-cbc', Buffer.alloc(16), Buffer.alloc(16)).update('x').length,
  new StringDecoder('utf8').write(Buffer.from([0xe2, 0x82, 0xac])),
);
`;
const EXPECTED = 'false true true true eb328910 0 €\n';

describe('vendored sources are read from the package beside the command module', () => {
  let kernel;
  const run = (argv) => kernel.run(argv, { cwd: '/os' });

  before(async () => {
    kernel = await createNodeKernel({ network: { transport: nodeTransport() }, commands: { append: [ROOT] } });
    for (const [path, data] of devPackageFiles('@ai-ecoverse/wasm-coreutils')) await kernel.writeFile(path, data);
    for (const [rel, data] of packageFiles()) await kernel.writeFile(`${STORE}/${rel}`, data);
    await kernel.writeFile('/os/uses.js', USES);
    await kernel.writeFile('/os/uses.jsh', USES);
    assert.equal((await run(['mkdir', '-p', `${ROOT}/@ai-ecoverse`])).status, 0);
    assert.equal((await run(['ln', '-s', '../.pnpm/@ai-ecoverse+slicc-jsh@0.0.0/node_modules/@ai-ecoverse/slicc-jsh', LINK])).status, 0);
  });

  after(() => kernel?.terminate());

  it('loads them through a pnpm-style link in a root no fixed path names', async () => {
    assert.deepEqual(await run(['node', 'uses.js']), { status: 0, stdout: EXPECTED, stderr: '' });
  });

  it('loads them in jsh', async () => {
    assert.deepEqual(await run(['jsh', 'uses.jsh']), { status: 0, stdout: EXPECTED, stderr: '' });
  });

  it('loads them in a Worker', async () => {
    const r = await run(['node', '-e', "new (require('worker_threads').Worker)('/os/uses.js')"]);
    assert.deepEqual(r, { status: 0, stdout: EXPECTED, stderr: '' });
  });

  it('reads a vendored source only when it is first used', async () => {
    assert.equal((await run(['rm', `${STORE}/dist/vendor/zlib.cjs`])).status, 0);
    assert.deepEqual(await run(['node', '-e', "console.log(require('crypto').createHash('md5').update('').digest('hex'))"]), {
      status: 0,
      stdout: 'd41d8cd98f00b204e9800998ecf8427e\n',
      stderr: '',
    });
    const r = await run(['node', '-e', "console.log('up'); try { require('zlib') } catch (e) { console.log(e.code, e.message) }"]);
    assert.deepEqual(r, {
      status: 0,
      stdout: 'up\nENOENT slicc-jsh: vendor bundle zlib is not embedded and was not found on disk\n',
      stderr: '',
    });
  });
});
