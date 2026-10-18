// AsyncLocalStorage where jsh carries the store as Node does: synchronous
// run/exit/enterWith, process.nextTick, timers, immediates, queueMicrotask,
// .then/.catch/.finally reactions, AsyncResource, bind and snapshot. (A
// native await continuation is the gap: test/integration/async-local-storage.)
const { AsyncLocalStorage, AsyncResource } = require('async_hooks');
const { EventEmitter } = require('events');
const { inspect } = require('util');
const als = new AsyncLocalStorage();
const other = new AsyncLocalStorage();
const log = [];
const note = (label) => log.push(`${label}: ${JSON.stringify([als.getStore(), other.getStore()])}`);

console.log('shape', Object.keys(als), inspect(new AsyncLocalStorage()), Object.getOwnPropertyNames(AsyncLocalStorage.prototype).join(), AsyncLocalStorage.bind.length, AsyncLocalStorage.snapshot.length);
note('top');
console.log('run returns', als.run('r', (a, b) => a + b + als.getStore(), 1, 2));
als.run('A', () => {
  note('sync');
  other.run('O', () => note('nested other'));
  als.run('A2', () => note('nested same'));
  note('after nested');
  als.exit(() => note('exit'));
  process.nextTick(() => note('nextTick'));
  setTimeout(() => note('setTimeout'), 1);
  const iv = setInterval(() => {
    note('setInterval');
    clearInterval(iv);
  }, 1);
  setImmediate(() => note('setImmediate'));
  queueMicrotask(() => note('queueMicrotask'));
  Promise.resolve(1).then(() => note('then'));
  Promise.reject(new Error('x')).catch(() => note('catch'));
  Promise.resolve().finally(() => note('finally'));
  Promise.resolve().then(() => note('then 1')).then(() => note('then 2'));
  const resource = new AsyncResource('X');
  setTimeout(() => {
    als.run('B', () => resource.runInAsyncScope(() => note('runInAsyncScope')));
  }, 2);
  const bound = AsyncLocalStorage.bind(() => note('AsyncLocalStorage.bind'));
  const snap = AsyncLocalStorage.snapshot();
  const rbound = resource.bind(() => note('resource.bind'));
  setTimeout(() => {
    als.run('C', () => {
      bound();
      snap(() => note('snapshot'));
      rbound();
      note('inside C');
    });
  }, 3);
  setTimeout(() => process.nextTick(() => setImmediate(() => note('timer > tick > immediate'))), 4);
});
note('after run');
const later = Promise.resolve();
als.run('D', () => later.then(() => note('then registered in run, promise from outside')));
const made = als.run('E', () => Promise.resolve());
made.then(() => note('then registered outside, promise made in run'));
const emitter = new EventEmitter();
als.run('F', () => emitter.on('ev', () => note('listener added in run, emitted outside')));
emitter.emit('ev');
als.run('G', () => emitter.emit('ev'));
setTimeout(() => {
  als.enterWith('H');
  note('enterWith');
  setTimeout(() => note('timer after enterWith'), 1);
}, 5);
setTimeout(() => note('timer outside, after the enterWith one'), 6);
setTimeout(() => {
  als.run('I', () => {
    als.disable();
    note('disabled');
  });
  note('after disable');
  als.run('J', () => note('run re-enables'));
}, 8);
// Once everything above has run (the loop has nothing left), not at a set
// time: a nested timer can come late on a loaded machine. Sorted: which of
// a timer and an immediate goes first is the event loop's timing (in Node
// too); the store each one sees is what's checked.
process.once('beforeExit', () => {
  for (const line of [...log].sort()) console.log(line);
});
