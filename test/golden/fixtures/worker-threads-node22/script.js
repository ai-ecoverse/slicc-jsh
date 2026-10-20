// worker_threads.Worker against host Node 22. Each case waits for its
// worker's last event before the next starts.
const { Worker, isMainThread, threadId, setEnvironmentData, SHARE_ENV } = require('worker_threads');
const path = require('path');
const w = path.join(__dirname, 'w.js');
const log = (...args) => console.log(...args);
const json = (v) => JSON.stringify(v);
const err = (e) => `${e?.constructor?.name} ${e?.code} ${e?.message}`;

function events(worker, label) {
  const seen = [];
  worker.on('online', () => seen.push('online'));
  worker.on('message', (m) => seen.push(`message ${json(m)}`));
  worker.on('error', (e) => seen.push(`error ${e instanceof Error ? err(e) : json(e)}`));
  return new Promise((resolve) =>
    worker.on('exit', (code) => {
      seen.push(`exit ${code}`);
      log(label, seen.join(' | '));
      resolve(code);
    })
  );
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('main thread', async () => log('isMainThread', isMainThread, 'threadId', threadId));

test('echo', async () => {
  const worker = new Worker(w, { workerData: { mode: 'echo', pid: process.pid, nested: { a: [1, 2] } }, argv: ['x', 'y'], execArgv: [] });
  log('threadId', worker.threadId);
  const done = events(worker, 'echo:');
  worker.postMessage('before online');
  worker.once('message', () => {
    worker.postMessage({ n: 1 });
    worker.postMessage('bye');
  });
  await done;
});

test('process.exit', async () => {
  const code = await events(new Worker(w, { workerData: { mode: 'exit' } }), 'exit:');
  log('code', code);
});

test('uncaught error', async () => {
  await events(new Worker(w, { workerData: { mode: 'throw' } }), 'throw:');
  await events(new Worker(w, { workerData: { mode: 'throw-value' } }), 'throw value:');
});

test('terminate', async () => {
  const worker = new Worker(w, { workerData: { mode: 'forever' } });
  const done = events(worker, 'terminate:');
  await new Promise((r) => worker.once('message', r));
  log('terminate resolves', await worker.terminate());
  await done;
  log('terminate again', await worker.terminate());
});

test('eval', async () => {
  const worker = new Worker(
    "const { parentPort, workerData } = require('worker_threads'); parentPort.postMessage([workerData, typeof require, process.argv[1], __filename]);",
    { eval: true, workerData: 'ev' }
  );
  await events(worker, 'eval:');
});

test('esm', async () => {
  await events(new Worker(path.join(__dirname, 'w-esm.mjs'), { workerData: { m: 1 } }), 'esm file:');
  await events(new Worker(new URL('file://' + path.join(__dirname, 'w-esm.mjs')), { workerData: 2 }), 'esm url:');
});

test('transfers', async () => {
  const worker = new Worker(w, { workerData: { mode: 'transfer' } });
  const seen = [];
  const { port1, port2 } = new MessageChannel();
  port1.on('message', (m) => seen.push(`port1 ${json(m)}`));
  port1.postMessage('queued 1');
  port1.postMessage('queued 2');
  const buf = new ArrayBuffer(16);
  const sab = new SharedArrayBuffer(16);
  const view = new Int32Array(sab);
  worker.postMessage({ buf, port: port2, sab }, [buf, port2]);
  log('detached after transfer', buf.byteLength);
  const answered = new Promise((resolve) => worker.on('message', (m) => { seen.push(`worker ${json(m)}`); resolve(); }));
  // The worker writes into the shared memory, then waits on it.
  await new Promise((resolve) => {
    const poll = () => (Atomics.load(view, 0) === 1 ? resolve() : setImmediate(poll));
    poll();
  });
  log('worker saw', view[1], 'bytes');
  view[2] = 99;
  Atomics.store(view, 0, 2);
  Atomics.notify(view, 0);
  await answered;
  await new Promise((resolve) => port1.on('close', resolve));
  await worker.terminate();
  log('transfers:', seen.sort().join(' | '));
});

test('receiveMessageOnPort after Atomics.wait', async () => {
  const counter = new SharedArrayBuffer(4);
  const view = new Int32Array(counter);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(w, { workerData: { mode: 'sync-receive', counter, port: port2 }, transferList: [port2] });
  const done = events(worker, 'sync receive:');
  await new Promise((r) => worker.once('online', r));
  const post = (message, transfer) => {
    port1.postMessage(message, transfer);
    Atomics.add(view, 0, 1);
    Atomics.notify(view, 0);
  };
  post({ n: 1 });
  const buf = new Uint8Array([7, 8, 9]).buffer;
  post({ buf }, [buf]);
  log('moved buffer detached', buf.byteLength);
  post({ big: 'z'.repeat(2000000) });
  post({ n: 4 });
  await done;
});

test('stdio piped and as streams', async () => {
  await events(new Worker(w, { workerData: { mode: 'stdio' } }), 'stdio piped:');
  const worker = new Worker(w, { workerData: { mode: 'stdio' }, stdout: true, stderr: true });
  let out = '';
  let errOut = '';
  worker.stdout.on('data', (d) => (out += d));
  worker.stderr.on('data', (d) => (errOut += d));
  await events(worker, 'stdio streams:');
  log('captured', json(out), json(errOut));
});

test('env and environment data', async () => {
  process.env.WORKER_GOLDEN = 'from parent';
  setEnvironmentData('k', { v: 1 });
  await events(new Worker(w, { workerData: { mode: 'env' } }), 'env:');
  log('parent sees FROM_WORKER', process.env.FROM_WORKER);
  await events(new Worker(w, { workerData: { mode: 'env' }, env: { WORKER_GOLDEN: 'given' } }), 'env given:');
  log('SHARE_ENV', typeof SHARE_ENV);
});

test('resource limits', async () => {
  const worker = new Worker(w, { workerData: { mode: 'forever' }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
  await new Promise((r) => worker.once('message', r));
  log('limits', json(worker.resourceLimits));
  await worker.terminate();
  log('limits after exit', json(worker.resourceLimits));
});

test('nested', async () => {
  await events(new Worker(w, { workerData: { mode: 'nested' } }), 'nested:');
});

test('unsupported in a worker', async () => {
  await events(new Worker(w, { workerData: { mode: 'unsupported' } }), 'unsupported:');
});

test('errors', async () => {
  for (const [label, fn] of [
    ['bare name', () => new Worker('w.js')],
    ['not a string', () => new Worker(42)],
    ['eval not a string', () => new Worker(42, { eval: true })],
    ['bad argv', () => new Worker(w, { argv: 'x' })],
    ['bad env', () => new Worker(w, { env: 1 })],
    ['bad resourceLimits', () => new Worker(w, { resourceLimits: { maxOldGenerationSizeMb: 'x' } })],
  ]) {
    try {
      const worker = fn();
      log(label, 'no throw');
      await worker.terminate();
    } catch (e) {
      log(label, err(e));
    }
  }
});

test('unref', async () => {
  const worker = new Worker(w, { workerData: { mode: 'forever' } });
  await new Promise((r) => worker.once('message', r));
  worker.unref();
  log('unref: the program ends with the worker running');
});

(async () => {
  for (const [name, fn] of cases) {
    log(`--- ${name}`);
    await fn();
  }
})();
