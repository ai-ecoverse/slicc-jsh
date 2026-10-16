process.on('uncaughtException', (e, origin) => console.log('uncaught', e.message, origin));
process.nextTick(() => console.log('tick 1'));
process.nextTick(() => { throw new Error('from tick 2'); });
process.nextTick(() => console.log('tick 3'));
// The timer starts from the microtask: after the throwing tick, Node runs
// tick 3 and the microtask at its next callback, so a timer started at the
// top could come first when it is due by the first loop turn (#236).
Promise.resolve().then(() => {
  console.log('microtask');
  setTimeout(() => console.log('timer still runs'), 5);
});
