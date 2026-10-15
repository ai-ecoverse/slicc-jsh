process.on('uncaughtException', (e, origin) => console.log('uncaught', e.message, origin));
process.nextTick(() => console.log('tick 1'));
process.nextTick(() => { throw new Error('from tick 2'); });
process.nextTick(() => console.log('tick 3'));
setTimeout(() => console.log('timer still runs'), 5);
Promise.resolve().then(() => console.log('microtask'));
