// What an 'exit' listener queues: its microtasks run, with the program's
// globals and stdout; a tick, an immediate and a timer never do.
process.on('exit', (code) => {
  console.log('exit', code);
  queueMicrotask(() => {
    clearImmediate(setImmediate(() => console.log('cleared immediate ran')));
    setImmediate(() => console.log('immediate after exit ran'));
    console.log('microtask after exit', typeof setImmediate, typeof clearImmediate, typeof setTimeout, typeof clearTimeout);
    queueMicrotask(() => console.log('nested microtask after exit'));
  });
  Promise.resolve().then(() => console.log('then after exit', typeof process.nextTick));
  process.nextTick(() => console.log('tick after exit ran'));
  setTimeout(() => console.log('timer after exit ran'), 0);
});
console.log('main');
