/**
 * createNodeKernel's compileCache (slicc-kernel 1.142.0, #566 ask 3): with a
 * cache directory, the kernel's process workers keep V8's compiled jsh bundle
 * there and later processes and threads reuse it. jsh behaves the same cold,
 * warm, in a fresh kernel on the same cache, and when the directory can't be
 * created (the kernel then just doesn't cache).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withJsh } from './helpers.mjs';


// A program that exercises the bundle broadly: builtins, a Worker's message,
// an ES module, and an uncaught error's stack and exit status.
const PROGRAM = `
const { Worker } = require('worker_threads');
const zlib = require('zlib');
console.log(require('util').inspect({ gz: zlib.gzipSync('x'.repeat(100)).length > 0, ev: typeof require('events') }));
const w = new Worker("require('worker_threads').parentPort.postMessage(new MessageEvent('m', { data: 2 }).data * 21)", { eval: true });
w.on('message', (n) => {
  console.log('worker', n);
  import('data:text/javascript,export default 7').then((m) => {
    console.log('esm', m.default);
    function thrower() { throw new TypeError('boom'); }
    thrower();
  });
});
`;

// The cache's files, not its directories: a directory alone isn't a compiled bundle.
const files = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());

describe('compileCache: jsh runs the same with the kernel caching its compiled bundle', () => {
  let dir;
  let plain;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jsh-compile-cache-'));
    const jsh = await withJsh();
    await jsh.kernel.writeFile('/os/p.js', PROGRAM);
    plain = await jsh.run(['node', 'p.js']);
    await jsh.close();
    assert.equal(plain.status, 1, plain.stderr);
    assert.match(plain.stdout, /worker 42\nesm 7\n$/);
    assert.match(plain.stderr, /TypeError: boom\n {4}at thrower \(\/os\/p\.js:10:/);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('cold, warm and in a fresh kernel on the same cache: the same output, and the cache is used', async () => {
    const first = await withJsh({ compileCache: dir });
    await first.kernel.writeFile('/os/p.js', PROGRAM);
    const cold = await first.run(['node', 'p.js']);
    assert.notDeepEqual(files(dir), [], 'the first process left its compiled bundle in the cache');
    const warm = await first.run(['node', 'p.js']);
    await first.close();
    const second = await withJsh({ compileCache: dir });
    await second.kernel.writeFile('/os/p.js', PROGRAM);
    const fresh = await second.run(['node', 'p.js']);
    await second.close();
    for (const [name, r] of Object.entries({ cold, warm, fresh })) {
      assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: plain.status, stdout: plain.stdout, stderr: plain.stderr }, name);
    }
  });

  it("a cache directory that can't be created: the kernel doesn't cache, and jsh runs the same", async () => {
    // Under a regular file, so not even root can make it (a mode can't stop root).
    const parent = mkdtempSync(join(tmpdir(), 'jsh-compile-cache-ro-'));
    const blocker = join(parent, 'a-file');
    writeFileSync(blocker, '');
    try {
      const jsh = await withJsh({ compileCache: join(blocker, 'cache') });
      await jsh.kernel.writeFile('/os/p.js', PROGRAM);
      const r = await jsh.run(['node', 'p.js']);
      await jsh.close();
      assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: plain.status, stdout: plain.stdout, stderr: plain.stderr });
      assert.equal(statSync(blocker).isFile(), true);
      assert.deepEqual(readdirSync(parent), ['a-file']);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
