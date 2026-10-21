/**
 * createNodeKernel's compileCache (slicc-kernel 1.142.0, #566 ask 3): with a
 * cache directory, the kernel's process workers keep V8's compiled jsh bundle
 * there and later processes and threads reuse it. jsh behaves the same cold,
 * warm, in a fresh kernel on the same cache, and when the directory can't be
 * written (the kernel then just doesn't cache).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kernelAtLeast, kernelVersion, withJsh } from './helpers.mjs';

const skip = !kernelAtLeast('1.142.0') && `slicc-kernel ${kernelVersion} has no compileCache`;

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

const files = (dir) => readdirSync(dir, { recursive: true }).filter((f) => !f.endsWith('/'));

describe('compileCache: jsh runs the same with the kernel caching its compiled bundle', { skip }, () => {
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
  after(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

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

  it("a cache directory that can't be written: the kernel doesn't cache, and jsh runs the same", async () => {
    const locked = mkdtempSync(join(tmpdir(), 'jsh-compile-cache-ro-'));
    chmodSync(locked, 0o500);
    try {
      const jsh = await withJsh({ compileCache: locked });
      await jsh.kernel.writeFile('/os/p.js', PROGRAM);
      const r = await jsh.run(['node', 'p.js']);
      await jsh.close();
      assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: plain.status, stdout: plain.stdout, stderr: plain.stderr });
      assert.deepEqual(files(locked), []);
    } finally {
      chmodSync(locked, 0o700);
      rmSync(locked, { recursive: true, force: true });
    }
  });
});
