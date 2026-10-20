// The worker side: what script.js asks for, by workerData.mode.
const { parentPort, workerData, threadId, isMainThread, resourceLimits, getEnvironmentData, Worker } = require('worker_threads');
const mode = workerData?.mode;
if (mode === 'echo') {
  parentPort.postMessage({ hello: true, threadId, isMainThread, data: { ...workerData, pid: typeof workerData.pid }, samePid: process.pid === workerData.pid, argv: process.argv.slice(2), execArgv: process.execArgv });
  parentPort.on('message', (m) => {
    if (m === 'bye') parentPort.close();
    else parentPort.postMessage({ echo: m });
  });
} else if (mode === 'exit') {
  parentPort.postMessage('before exit');
  console.log('worker stdout before exit');
  process.exit(3);
} else if (mode === 'throw') {
  parentPort.postMessage('before throw');
  setTimeout(() => {
    throw new RangeError('boom from worker');
  }, 0);
} else if (mode === 'throw-value') {
  throw 42;
} else if (mode === 'forever') {
  parentPort.postMessage('running');
  setInterval(() => {}, 1000);
} else if (mode === 'transfer') {
  parentPort.once('message', ({ buf, port, sab }) => {
    port.postMessage({ fromWorker: 'via moved port' });
    port.on('message', (m) => {
      port.postMessage({ gotOnPort: m });
      if (m === 'queued 2') port.close();
    });
    const view = new Int32Array(sab);
    view[1] = buf.byteLength;
    Atomics.store(view, 0, 1);
    Atomics.notify(view, 0);
    // Wait for the main thread's answer in the same memory.
    Atomics.wait(view, 0, 1);
    parentPort.postMessage({ answer: view[2], sawLength: view[1] });
  });
} else if (mode === 'stdio') {
  console.log('out line 1');
  console.error('err line 1');
  process.stdout.write('out line 2\n');
} else if (mode === 'env') {
  process.env.FROM_WORKER = 'set';
  parentPort.postMessage({ inherited: process.env.WORKER_GOLDEN, env: getEnvironmentData('k'), limits: Object.keys(resourceLimits).sort() });
} else if (mode === 'nested') {
  const inner = new Worker(__filename, { workerData: { mode: 'echo', pid: process.pid } });
  inner.on('message', (m) => {
    if (m.hello) {
      parentPort.postMessage({ outer: threadId, inner: m.threadId, innerSamePid: m.samePid });
      inner.terminate();
    }
  });
} else if (mode === 'sync-receive') {
  // piscina's and tinypool's way: sleep on a counter, then drain the port
  // without going back to the event loop.
  const { receiveMessageOnPort } = require('worker_threads');
  const { counter, port } = workerData;
  const view = new Int32Array(counter);
  let seen = 0;
  const got = [];
  while (got.length < 4) {
    Atomics.wait(view, 0, seen);
    seen = Atomics.load(view, 0);
    let entry;
    while ((entry = receiveMessageOnPort(port)) !== undefined) {
      const m = entry.message;
      got.push(m.buf ? `buf ${new Uint8Array(m.buf).join(',')}` : m.big ? `big ${m.big.length}` : JSON.stringify(m));
    }
  }
  got.push(`then empty: ${receiveMessageOnPort(port)}`);
  parentPort.postMessage(got);
} else if (mode === 'unsupported') {
  const out = [];
  for (const [label, fn] of [
    ['chdir', () => process.chdir('/')],
    ['abort', () => process.abort()],
    ['umask set', () => process.umask(0o22)],
    ['setuid', () => process.setuid(0)],
  ]) {
    try {
      fn();
      out.push(`${label} ok`);
    } catch (e) {
      out.push(`${label} ${e.code} ${e.message}`);
    }
  }
  out.push(`umask read ${typeof process.umask()}`);
  parentPort.postMessage(out);
}
