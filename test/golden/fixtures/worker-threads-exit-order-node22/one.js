// One worker, made at the top level: its messages and its 'exit', logged as they come.
const { Worker } = require('worker_threads');
const w = new Worker(
  "const { parentPort } = require('worker_threads'); process.on('exit', () => parentPort.postMessage('from its exit handler')); parentPort.once('message', async ({ t }) => { const wr = t.writable.getWriter(); wr.write('x'); wr.close(); let s = ''; for await (const c of t.readable) s += c; parentPort.postMessage('read ' + s); });",
  { eval: true }
);
w.on('message', (m) => console.log('message:', m));
w.on('exit', (code) => console.log('exit', code));
const t = new TransformStream();
w.postMessage({ t }, [t]);
