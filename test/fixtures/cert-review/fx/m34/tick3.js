const log = (s) => console.log(s);
process.on('uncaughtException', (e) => log('uncaught ' + e.message));
process.nextTick(() => log('A tick1'));
process.nextTick(() => { throw new Error('A tick2'); });
process.nextTick(() => log('A tick3'));
Promise.resolve().then(() => log('A micro'));
setTimeout(() => {
  log('T cb');
  process.nextTick(() => log('T tick'));
  Promise.resolve().then(() => log('T micro'));
  queueMicrotask(() => log('T qm'));
  process.nextTick(() => log('T tick2'));
}, 50);
setTimeout(() => { log('T2 cb'); process.nextTick(() => log('T2 tick')); }, 50);
setImmediate(() => { log('I cb'); Promise.resolve().then(() => log('I micro')); process.nextTick(() => log('I tick')); });
setImmediate(() => log('I2 cb'));
setTimeout(() => {
  Promise.resolve().then(() => { log('M micro1'); process.nextTick(() => log('M tick in micro')); Promise.resolve().then(() => log('M micro2')); });
  process.nextTick(() => { log('M tick'); throw new Error('M tick throws'); });
  process.nextTick(() => log('M tick after throw'));
}, 120);
