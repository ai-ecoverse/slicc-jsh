import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// Fix 13's Node 22 behaviour where the golden harness can't follow: host Node
// runs under npx (a signal death becomes status 1), Node's own frames differ
// from ours, and Brotli/Zstd/key pairs do exist in host Node. The goldens
// node22-gaps, exit-listener-*, input-type-*, stdin-*, function-import,
// console-force-color and kill-self-unref pin the rest against Node.
describe('smaller Node 22 gaps (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());
  const node = (...argv) => jsh.run(['node', ...argv]);

  it('process.kill(self) with no handler ends the program at once: 128 + n, no exit event', async () => {
    const r = await node('-e', "process.on('exit', () => console.log('exit ran')); process.kill(process.pid, 'SIGTERM'); console.log('after')");
    assert.equal(r.status, 143);
    assert.equal(r.stdout, '');
    const hup = await node('-e', "process.kill(process.pid, 1); console.log('after')");
    assert.equal(hup.status, 129);
    assert.equal(hup.stdout, '');
  });

  it('a handled signal runs while the loop is alive, as a later turn', async () => {
    const r = await node(
      '-e',
      "process.on('SIGUSR2', (n, num) => console.log('handler', n, num)); process.kill(process.pid, 'SIGUSR2'); console.log('after'); setTimeout(() => {}, 20)"
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'after\nhandler SIGUSR2 12\n');
  });

  // Not a golden: Linux coalesces the pending signal and libuv's handler
  // order is by handle address, so host Node's output varies.
  it('a self-signal reaches listeners under every name of its number (SIGABRT/SIGIOT)', async () => {
    const r = await node(
      '-e',
      "process.on('SIGIOT', (n, num) => console.log('IOT', n, num)); process.on('SIGABRT', (n, num) => console.log('ABRT', n, num)); console.log(process.kill(process.pid, 'SIGABRT')); setTimeout(() => {}, 20)"
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split('\n').filter(Boolean).sort(), ['ABRT SIGABRT 6', 'IOT SIGIOT 6', 'true']);
  });

    it('SIGIO / 29 reach a SIGPOLL listener (same Linux number), as in Node', async () => {
    const r = await node(
      '-e',
      "process.on('SIGPOLL', (n, num) => console.log('poll', n, num)); process.kill(process.pid, 'SIGIO'); process.kill(process.pid, 29); setTimeout(() => {}, 20)"
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'poll SIGPOLL 29\npoll SIGPOLL 29\n');
  });

    it('console.trace prints Trace: and the caller frames to stderr', async () => {
    const r = await node('-e', "function f() { console.trace('here %d', 1); } f()");
    assert.equal(r.status, 0);
    assert.match(r.stderr, /^Trace: here 1\n {4}at f \(\[eval\]:1:24\)\n/);
  });

  it('--input-type=module with -p is ERR_EVAL_ESM_CANNOT_PRINT', async () => {
    const r = await node('--input-type=module', '-p', '1');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^Error \[ERR_EVAL_ESM_CANNOT_PRINT\]: --print cannot be used with ESM input$/m);
  });

  it("ESM -e input is <cwd>/[eval1]: an unsettled top-level await names it", async () => {
    const r = await jsh.run(['node', '--input-type=module', '-e', 'await new Promise(() => {})'], { cwd: '/os' });
    assert.equal(r.status, 13);
    assert.match(r.stderr, /^Warning: Detected unsettled top-level await at file:\/\/\/os\/\[eval1\]/);
  });

  it('the Brotli/Zstd and key-pair callback forms report unavailability through the callback', async () => {
    const r = await node(
      '-e',
      [
        "const zlib = require('zlib'); const crypto = require('crypto');",
        "let sync = true;",
        "zlib.brotliCompress('x', (e) => console.log('brotliCompress', e.code, sync));",
        "zlib.zstdDecompress(Buffer.alloc(1), {}, (e) => console.log('zstdDecompress', e.code, sync));",
        "crypto.generateKeyPair('rsa', { modulusLength: 512 }, (e) => console.log('generateKeyPair', e.code, sync));",
        "crypto.generatePrime(8, (e) => console.log('generatePrime', e.code, sync));",
        'sync = false;',
      ].join('\n')
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      [
        'brotliCompress ERR_FEATURE_UNAVAILABLE_ON_PLATFORM false',
        'zstdDecompress ERR_FEATURE_UNAVAILABLE_ON_PLATFORM false',
        'generateKeyPair ERR_FEATURE_UNAVAILABLE_ON_PLATFORM false',
        'generatePrime ERR_FEATURE_UNAVAILABLE_ON_PLATFORM false',
        '',
      ].join('\n')
    );
  });

  it('an uncaughtException listener or capture callback that throws is fatal: its own error, status 7', async () => {
    const a = await node('-e', "process.setUncaughtExceptionCaptureCallback(() => { throw new Error('in cb'); }); throw new Error('orig')");
    assert.equal(a.status, 7);
    assert.match(a.stderr, /\nError: in cb\n/);
    assert.doesNotMatch(a.stderr, /Error: orig/);
    const b = await node('-e', "process.on('exit', (c) => console.log('exit', c)); process.on('uncaughtException', () => { throw new Error('in listener'); }); setTimeout(() => { throw new Error('orig'); }, 1)");
    assert.equal(b.status, 7);
    assert.equal(b.stdout, 'exit 7\n');
    assert.match(b.stderr, /\nError: in listener\n/);
  });

  it('process.abort() dies of SIGABRT whatever listens for it (no exit event)', async () => {
    const r = await node('-e', "process.on('SIGABRT', () => console.log('listener')); process.on('exit', () => console.log('exit')); process.abort(); console.log('after')");
    assert.equal(r.status, 134);
    assert.equal(r.stdout, '');
  });

  it('process.ppid is a number, from the kernel', async () => {
    const r = await node('-p', 'Number.isInteger(process.ppid) && process.ppid >= 0');
    assert.equal(r.stdout, 'true\n');
  });
});
