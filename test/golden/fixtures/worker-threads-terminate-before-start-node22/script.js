const { Worker } = require('worker_threads');
const w = new Worker("const { parentPort } = require('worker_threads'); console.log('worker out'); console.error('worker err'); parentPort.postMessage('hi'); throw new Error('boom');", { eval: true });
for (const e of ['online', 'message', 'error', 'messageerror']) w.on(e, (v) => console.log(e, v instanceof Error ? v.message : v));
w.on('exit', (code) => console.log('exit', code, w.threadId));
w.postMessage('to the worker');
w.terminate().then((code) => console.log('terminated', code));
process.on('exit', (code) => console.log('the program ends', code));
