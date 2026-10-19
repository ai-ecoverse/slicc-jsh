import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devPackageTree, kernelAtLeast, withJsh } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const version = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
// Workers on the kernel's JS threads (ai-ecoverse/slicc-kernel#1094).
const THREADS_KERNEL = '1.130.0';

// The real piscina and tinypool run tasks on worker threads. Their workers
// sleep on a counter in shared memory (Atomics.wait) and drain their port
// synchronously (receiveMessageOnPort), unless told not to.
describe('worker pools (kernel)', { skip: !kernelAtLeast(THREADS_KERNEL) }, () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    for (const name of ['piscina', 'tinypool']) for (const [path, data] of devPackageTree(name)) await jsh.kernel.writeFile(path, data);
    await jsh.kernel.writeFile(
      '/os/pool/task.js',
      `const { threadId, isMainThread } = require('worker_threads');
module.exports = ({ a, b }) => ({ sum: a + b, threadId, isMainThread, pid: process.pid });
module.exports.sum = (buf) => new Uint8Array(buf).reduce((x, y) => x + y, 0);
module.exports.textLength = ({ text }) => text.length;
`
    );
    await jsh.kernel.writeFile(
      '/os/pool/task.mjs',
      "import { threadId } from 'node:worker_threads';\nexport default ({ a, b }) => ({ product: a * b, threadId });\n"
    );
  });
  after(() => jsh?.close());

  const run = async (code) => {
    await jsh.kernel.writeFile('/os/pool/main.js', code);
    const r = await jsh.run(['node', 'main.js'], { cwd: '/os/pool' });
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    return r.stdout.trim().split('\n');
  };

  it('piscina in each of its atomics modes: tasks on two threads, a moved buffer, a message bigger than the mailbox, an ES module task', async () => {
    assert.equal(version('piscina'), '5.3.2');
    const lines = await run(`const { Piscina } = require('piscina');
(async () => {
  for (const atomics of ['sync', 'async', 'disabled']) {
    const pool = new Piscina({ filename: __dirname + '/task.js', minThreads: 2, maxThreads: 2, atomics });
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((a) => pool.run({ a, b: 10 })));
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const moved = await pool.run(Piscina.move(buf), { name: 'sum' });
    const big = await pool.run({ text: 'x'.repeat(3000000) }, { name: 'textLength' });
    console.log(atomics, JSON.stringify(results.map((r) => r.sum)), new Set(results.map((r) => r.threadId)).size, results.every((r) => !r.isMainThread && r.pid === process.pid), moved, buf.byteLength, big);
    await pool.destroy();
  }
  const esm = new Piscina({ filename: __dirname + '/task.mjs', maxThreads: 2 });
  console.log('esm', JSON.stringify((await Promise.all([esm.run({ a: 2, b: 3 }), esm.run({ a: 4, b: 5 })])).map((r) => r.product)));
  await esm.destroy();
})();
`);
    assert.deepEqual(lines, [
      'sync [11,12,13,14,15,16] 2 true 6 0 3000000',
      'async [11,12,13,14,15,16] 2 true 6 0 3000000',
      'disabled [11,12,13,14,15,16] 2 true 6 0 3000000',
      'esm [6,20]',
    ]);
  });

  it('tinypool with and without useAtomics: tasks on two threads', async () => {
    assert.equal(version('tinypool'), '1.1.1');
    const lines = await run(`(async () => {
  const { Tinypool } = await import('tinypool');
  for (const useAtomics of [true, false]) {
    const pool = new Tinypool({ filename: __dirname + '/task.js', minThreads: 2, maxThreads: 2, useAtomics });
    const out = await Promise.all([1, 2, 3, 4].map((a) => pool.run({ a, b: 1 })));
    console.log(useAtomics, JSON.stringify(out.map((r) => r.sum)), new Set(out.map((r) => r.threadId)).size);
    await pool.destroy();
  }
})();
`);
    assert.deepEqual(lines, ['true [2,3,4,5] 2', 'false [2,3,4,5] 2']);
  });
});
