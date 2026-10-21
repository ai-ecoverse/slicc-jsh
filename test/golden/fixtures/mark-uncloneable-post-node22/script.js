// worker_threads.markAsUncloneable, and Node's MessageEvents (undici marks
// them): such an object anywhere in a message posted to a port, a
// BroadcastChannel or a worker, or in workerData, is a DataCloneError.
// Node refuses only an ordinary object or an Error so marked: an array, a
// Map, a Date or a buffer still goes. (The global structuredClone is not
// tried: it is the platform's in jsh.)
const { Worker, MessageChannel, BroadcastChannel, markAsUncloneable, isMainThread, parentPort } = require('worker_threads');

const outcome = (label, fn) => {
  try {
    fn();
    return `${label} posted`;
  } catch (e) {
    return `${label} ${e instanceof DOMException} ${e.name} ${e.code} ${e.message}`;
  }
};
const tried = (label, fn) => console.log(outcome(label, fn));
const mark = (value) => (markAsUncloneable(value), value);

if (!isMainThread) {
  // Its outcome goes back as a message: the worker's stdout is not ordered
  // with the main thread's.
  parentPort.postMessage(outcome('worker: parentPort, marked', () => parentPort.postMessage({ a: mark({}) })));
  return;
}

const { port1, port2 } = new MessageChannel();
tried('port: marked', () => port1.postMessage(mark({ x: 1 })));
tried('port: marked, in a Map in an array', () => port1.postMessage({ a: [new Map([[1, mark({})]])] }));
tried('port: marked class instance', () => port1.postMessage({ c: mark(new (class A {})()) }));
tried('port: marked Error', () => port1.postMessage([mark(new Error('e'))]));
tried('port: a MessageEvent', () => port1.postMessage(new MessageEvent('m')));
tried('port: a MessageEvent, nested', () => port1.postMessage({ e: new MessageEvent('m', { data: 1 }) }));
tried('port: marked array, Map, Date, Uint8Array, ArrayBuffer', () =>
  port1.postMessage({ a: mark([1]), m: mark(new Map([[1, 2]])), d: mark(new Date(0)), u: mark(new Uint8Array([7])), b: mark(new ArrayBuffer(2)) })
);
tried('port: a primitive marked', () => (markAsUncloneable(1), markAsUncloneable(null), port1.postMessage(1)));
port2.once('message', (m) => {
  console.log('port: got', Array.isArray(m.a), m.m instanceof Map, m.d instanceof Date, m.u[0], m.b.byteLength);
  port2.once('message', (n) => {
    console.log('port: then got', n);
    port1.close();
    channel();
  });
});

function channel() {
  const a = new BroadcastChannel('uncloneable');
  const b = new BroadcastChannel('uncloneable');
  tried('channel: marked', () => a.postMessage({ x: mark({}) }));
  tried('channel: a MessageEvent', () => a.postMessage([new MessageEvent('m')]));
  const { port1: p } = new MessageChannel();
  tried('channel: a port', () => a.postMessage({ p }));
  p.close();
  tried('channel: plain', () => a.postMessage({ ok: 1 }));
  b.onmessage = (e) => {
    console.log('channel: got', JSON.stringify(e.data));
    a.close();
    b.close();
    worker();
  };
}

function worker() {
  tried('workerData: marked', () => new Worker(__filename, { workerData: { d: mark({}) } }));
  const w = new Worker(__filename);
  tried('worker.postMessage: marked', () => w.postMessage({ x: mark({}) }));
  w.on('message', (m) => console.log(m));
  w.on('exit', (code) => console.log('worker: exit', code));
}
