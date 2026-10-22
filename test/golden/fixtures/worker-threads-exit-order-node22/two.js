const { Worker } = require('worker_threads');
const ended = new Int32Array(new SharedArrayBuffer(4));
const w = new Worker(
  "const { parentPort, workerData } = require('worker_threads'); process.on('exit', () => { parentPort.postMessage('from its exit handler'); Atomics.store(workerData, 0, 1); Atomics.notify(workerData, 0); }); parentPort.postMessage('first');",
  { eval: true, workerData: ended }
);
w.on('message', (m) => {
  console.log('message:', m);
  if (m === 'first') Atomics.wait(ended, 0, 0);
});
w.on('exit', (code) => console.log('exit', code));
