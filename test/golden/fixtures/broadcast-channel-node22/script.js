const util = require('util');
const { BroadcastChannel: WT } = require('worker_threads');
console.log('worker_threads export is the global:', WT === BroadcastChannel, typeof BroadcastChannel);
const a = new BroadcastChannel('room');
const b = new BroadcastChannel('room');
const c = new BroadcastChannel('room');
const other = new BroadcastChannel('elsewhere');
const log = [];
const payload = { n: 1, list: [1, 2], when: new Date(0), map: new Map([['k', 'v']]) };
a.onmessage = (e) => log.push(`a got ${JSON.stringify(e.data)}`);
b.addEventListener('message', (e) => {
  log.push(`b got ${e.constructor.name} ${JSON.stringify(e.data)} same=${e.data === payload} date=${e.data.when instanceof Date} map=${e.data.map instanceof Map} origin=${JSON.stringify(e.origin)} source=${e.source} ports=${e.ports.length}`);
});
c.onmessage = (e) => log.push(`c got ${JSON.stringify(e.data)}`);
other.onmessage = (e) => log.push(`other got ${JSON.stringify(e.data)}`);
console.log('inspect:', util.inspect(a), 'name:', a.name, 'onmessageerror:', a.onmessageerror);
a.postMessage(payload);
b.postMessage('from b');
log.push('posted (same turn)');
const errs = [];
try {
  new BroadcastChannel();
} catch (e) {
  errs.push(`${e.name} ${e.code} ${e.message}`);
}
try {
  a.postMessage();
} catch (e) {
  errs.push(`${e.name} ${e.code} ${e.message}`);
}
try {
  a.postMessage(() => {});
} catch (e) {
  errs.push(`${e.name} ${e.code}`);
}
console.log('errors:', errs.join(' | '));
setTimeout(() => {
  console.log(log.join('\n'));
  c.close();
  c.close();
  try {
    c.postMessage(1);
  } catch (e) {
    console.log('after close:', e.name, e.code, e.message);
  }
  console.log('closed inspect:', util.inspect(c));
  console.log('ref/unref return the channel:', a.unref() === a, a.ref() === a);
  a.close();
  b.close();
  other.unref();
  // Microtasks a handler queues run before the next message (Node's checkpoint per message).
  const x = new BroadcastChannel('m');
  const y = new BroadcastChannel('m');
  const z = new BroadcastChannel('m');
  const order = [];
  y.onmessage = (e) => {
    order.push(`y ${e.data}`);
    queueMicrotask(() => order.push(`y micro ${e.data}`));
    Promise.resolve().then(() => Promise.resolve()).then(() => order.push(`y deep ${e.data}`));
  };
  z.onmessage = (e) => order.push(`z ${e.data}`);
  x.onmessage = (e) => order.push(`x ${e.data}`);
  x.postMessage('m1');
  x.postMessage('m2');
  y.postMessage('m3');
  setTimeout(() => {
    console.log(order.join(' | '));
    x.close();
    y.close();
    z.close();
    const wt = require('worker_threads');
    console.log('setEnvironmentData returns', wt.setEnvironmentData('k', 1), wt.getEnvironmentData('k'));
    // other is unref'd, the rest closed: the program ends.
  }, 30);
}, 20);
