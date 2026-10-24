const util = require('node:util');
const { Worker } = require('node:worker_threads');
const fulfilled = Promise.resolve(1);
const rejected = Promise.reject('x');
rejected.catch(() => {});
const error = Promise.reject(Object.assign(new Error('boom'), { stack: 'Error: boom\n    at somewhere (/app/x.js:1:1)' }));
error.catch(() => {});
class Sub extends Promise {}
console.log('sync', Promise.resolve({ a: 1 }), new Promise((resolve) => resolve(Promise.resolve(2))));
const unhandled = Promise.reject(7);
console.log('unhandled', unhandled);
process.on('unhandledRejection', (reason, promise) => console.log('unhandledRejection', reason, promise === unhandled));
process.on('rejectionHandled', () => console.log('rejectionHandled'));
setTimeout(() => {
  console.log(fulfilled, rejected, new Promise(() => {}));
  console.log(error);
  console.log(util.inspect({ a: [Promise.resolve({ x: 1 })], n: Promise.resolve(undefined) }, { depth: 4 }));
  console.log(util.inspect(Promise.resolve(Promise.resolve('s'))), util.inspect(Promise.resolve(null)), util.inspect(Promise.resolve(-0)));
  console.log(Sub.resolve(5), Sub.reject(6).catch(() => {}), Sub.reject(8));
  console.log(util.format('%o', Promise.resolve(3)), util.format('%O', Promise.reject(4).catch(() => {}) && Promise.resolve(9)));
  console.log(util.inspect(Promise.resolve(10), { colors: true }), util.inspect(Promise.resolve({ deep: { er: { x: 1 } } }), { depth: 0 }));
  new Worker(
    `const { parentPort } = require('node:worker_threads');
    const r = Promise.reject(11);
    r.catch(() => {});
    parentPort.postMessage(require('node:util').inspect([Promise.resolve(10), r, new Promise(() => {})]));`,
    { eval: true }
  ).on('message', (m) => console.log('worker', m));
}, 10);
