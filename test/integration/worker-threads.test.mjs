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
    assert.equal(version('tinypool'), '2.2.0');
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

  it('tinypool on worker threads and on child processes, isolated or not: env, a task that throws, an aborted task', async () => {
    await jsh.kernel.writeFile(
      '/os/pool/tp.js',
      `const { isMainThread } = require('worker_threads');
module.exports = ({ a, b }) => ({ sum: a + b, isMainThread, foo: process.env.FOO, pid: process.pid });
module.exports.boom = () => { throw Object.assign(new Error('boom'), { code: 'EBOOM' }); };
module.exports.never = () => new Promise(() => {});
`
    );
    const lines = await run(`(async () => {
  const { Tinypool } = await import('tinypool');
  for (const runtime of ['worker_threads', 'child_process']) for (const isolateWorkers of [false, true]) {
    const pool = new Tinypool({ filename: __dirname + '/tp.js', minThreads: 2, maxThreads: 2, runtime, isolateWorkers, env: { FOO: 'bar' } });
    const out = await Promise.all([1, 2, 3].map((a) => pool.run({ a, b: 1 })));
    const error = await pool.run({}, { name: 'boom' }).catch((e) => e.message);
    const ac = new AbortController();
    const aborted = pool.run({}, { name: 'never', signal: ac.signal }).catch((e) => e.message);
    ac.abort();
    console.log(runtime, isolateWorkers, JSON.stringify(out.map((r) => r.sum)), out.every((r) => r.isMainThread === (runtime === 'child_process') && r.foo === 'bar' && (r.pid === process.pid) === (runtime === 'worker_threads')), error, await aborted);
    await pool.destroy();
  }
})();
`);
    assert.deepEqual(lines, [
      'worker_threads false [2,3,4] true boom The task has been aborted',
      'worker_threads true [2,3,4] true boom The task has been aborted',
      'child_process false [2,3,4] true boom The task has been aborted',
      'child_process true [2,3,4] true boom The task has been aborted',
    ]);
  });
});

// A thread can crash below the program (exit code 257): no program can make
// that happen, so `crashnode` is jsh's own bundle run on the kernel's ctx
// with ctx.thread.spawn wrapped: its threads are real, but the kernel says
// 257 when one ends, and globalThis.__crashThread ends the last one, as the
// kernel ends a thread that crashed.
describe('a worker whose thread crashes (kernel)', { skip: !kernelAtLeast(THREADS_KERNEL) }, () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    const bundle = readFileSync(join(root, 'dist/node.mjs'), 'utf8').replace(/export\s*\{\s*main as default\s*\};?\s*$/, '');
    await jsh.kernel.writeFile(
      '/node_modules/crashnode/package.json',
      JSON.stringify({ name: 'crashnode', version: '1.0.0', type: 'module', slicc: { commands: { crashnode: { abi: 'js', module: 'index.mjs' } } } })
    );
    await jsh.kernel.writeFile(
      '/node_modules/crashnode/index.mjs',
      `${bundle}
export default function crashnode(ctx) {
  if (ctx.thread.tid) return main(ctx);
  const real = ctx.thread;
  const thread = Object.freeze({
    tid: real.tid,
    port: real.port,
    data: real.data,
    NO_MEMORY: real.NO_MEMORY,
    CRASHED: real.CRASHED,
    spawn: async (options) => {
      const t = await real.spawn(options);
      globalThis.__crashThread = () => t.terminate();
      return { tid: t.tid, port: t.port, terminate: () => t.terminate(), exited: t.exited.then(() => real.CRASHED) };
    },
  });
  return main(new Proxy({}, { get: (_, key) => (key === 'thread' ? thread : ctx[key]), has: (_, key) => key in ctx }));
}
`
    );
  });
  after(() => jsh?.close());

  const run = async (onMessage) => {
    await jsh.kernel.writeFile(
      '/os/crash.js',
      `const { Worker } = require('worker_threads');
const w = new Worker('require("worker_threads").parentPort.postMessage("up"); setInterval(() => {}, 1000);', { eval: true });
w.on('message', (m) => { console.log('message', m); ${onMessage} });
w.on('error', (e) => console.log('error', e.code, e.message));
w.on('exit', (code) => console.log('exit', code));
`
    );
    const r = await jsh.run(['crashnode', 'crash.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    return r.stdout;
  };

  it("a crash is an 'error', ERR_WORKER_CRASHED, then 'exit' 1", async () => {
    assert.equal(await run('globalThis.__crashThread();'), "message up\nerror ERR_WORKER_CRASHED slicc-jsh: the worker's thread crashed\nexit 1\n");
  });

  it("terminate() is no error, whatever code the kernel gives the thread", async () => {
    assert.equal(await run('w.terminate();'), 'message up\nexit 1\n');
  });

  it("with no 'error' listener, the crash is the program's uncaught exception, and the worker still ends", async () => {
    await jsh.kernel.writeFile(
      '/os/crash-unheard.js',
      `const { Worker } = require('worker_threads');
process.on('uncaughtException', (e) => console.log('uncaught', e.code));
const w = new Worker('require("worker_threads").parentPort.postMessage("up"); setInterval(() => {}, 1000);', { eval: true });
w.on('message', (m) => { console.log('message', m); globalThis.__crashThread(); });
w.on('exit', (code) => console.log('exit', code));
process.on('exit', () => console.log('the program ends'));
`
    );
    const r = await jsh.run(['crashnode', 'crash-unheard.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'message up\nuncaught ERR_WORKER_CRASHED\nexit 1\nthe program ends\n');
  });
});

// A post to a worker whose transfer list has a jsh port and something that
// can't be transferred (a locked stream): the post fails before the port is
// exported, so the port stays usable. (Node loses it there; jsh keeps it.)
describe('worker transfers (kernel)', { skip: !kernelAtLeast(THREADS_KERNEL) }, () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it('a locked stream in a transfer list fails the post, and the port in it still works', async () => {
    await jsh.kernel.writeFile(
      '/os/locked.js',
      `const { Worker, MessageChannel } = require('worker_threads');
const w = new Worker('require("worker_threads").parentPort.on("message", () => {})', { eval: true });
w.once('online', () => {
  const { port1, port2 } = new MessageChannel();
  const locked = new ReadableStream();
  locked.getReader();
  try {
    w.postMessage({ port1 }, [port1, locked]);
    console.log('posted');
  } catch (e) {
    console.log('post:', e.name);
  }
  port2.once('message', (m) => {
    console.log('the port still works:', m);
    port2.close();
    w.terminate();
  });
  port1.postMessage('hello');
});
`
    );
    const r = await jsh.run(['node', 'locked.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'post: DataCloneError\nthe port still works: hello\n');
  });
});
