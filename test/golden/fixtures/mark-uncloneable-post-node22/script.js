// worker_threads.markAsUncloneable, and Node's MessageEvents (undici marks
// them): such an object anywhere in a message posted to a port or a worker,
// or in workerData, is a DataCloneError. (A BroadcastChannel's post is not
// checked in jsh, nor is the global structuredClone: the platform's.)
// Node refuses only an ordinary object or an Error so marked: an array, a
// Map, a Date or a buffer still goes.
const { Worker, MessageChannel, markAsUncloneable, isMainThread, parentPort } = require('worker_threads');

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
// Where structured clone looks, and only there: what a getter gives (read
// once), an Error's own cause and an array's own properties; not a Date's,
// a RegExp's, a buffer's, a Map's or an Error's own (not cloned), nor a
// cause that is a getter.
const extra = (object) => Object.assign(object, { extra: mark({}) });
let reads = 0;
tried('port: marked, from a getter', () => port1.postMessage({ get g() { reads += 1; return mark({}); } }));
console.log('port: the getter read', reads);
tried("port: marked, an Error's cause", () => port1.postMessage(new Error('e', { cause: mark({}) })));
tried("port: marked, an Error's cause getter", () => port1.postMessage(Object.defineProperty(new Error('e'), 'cause', { get: () => mark({}) })));
tried("port: marked, an array's own", () => port1.postMessage(extra([1])));
for (const [kind, object] of [['Date', new Date(0)], ['RegExp', /x/], ['Uint8Array', new Uint8Array(1)], ['Map', new Map()], ['Error', new Error('e')]]) {
  tried(`port: marked, a ${kind}'s own`, () => port1.postMessage(extra(object)));
}
const { port1: loose } = new MessageChannel();
tried('port: a port, from a getter', () => port1.postMessage({ get p() { return loose; } }));
tried("port: a port, a Date's own", () => port1.postMessage(Object.assign(new Date(0), { p: loose })));
loose.close();
// What went, in order: the marked kinds, 1, then each one the clone drops
// a marked object from (shown by what it kept).
const got = [];
port2.on('message', (m) => {
  got.push(m);
  if (got.length < 9) return;
  const [kinds, one, ...rest] = got;
  console.log('port: got', Array.isArray(kinds.a), kinds.m instanceof Map, kinds.d instanceof Date, kinds.u[0], kinds.b.byteLength);
  console.log('port: then got', one);
  console.log('port: then', rest.map((x) => `${Object.prototype.toString.call(x)} ${JSON.stringify(Object.keys(x))}`).join(', '));
  port1.close();
  worker();
});

function worker() {
  tried('workerData: marked', () => new Worker(__filename, { workerData: { d: mark({}) } }));
  const w = new Worker(__filename);
  tried('worker.postMessage: marked', () => w.postMessage({ x: mark({}) }));
  w.on('message', (m) => console.log(m));
  w.on('exit', (code) => console.log('worker: exit', code));
}
