// A Worker's 'exit' doesn't depend on the program's setImmediate, as in
// Node 22: a program that removes it, and require('timers')'s, still gets
// its worker's message and exit, and the program ends.
const { Worker } = require('worker_threads');
globalThis.setImmediate = undefined;
require('timers').setImmediate = undefined;
const w = new Worker("require('worker_threads').parentPort.postMessage('hi')", { eval: true });
w.on('message', (m) => console.log('message', m));
w.on('exit', (code) => console.log('exit', code));
process.on('exit', () => console.log('the program ends'));
