process.on('exit', (c) => console.log('exit listener', c));
process.nextTick(() => { throw new Error('unhandled tick'); });
setTimeout(() => console.log('never'), 5);
