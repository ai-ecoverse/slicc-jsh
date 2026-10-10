console.log(typeof Buffer, typeof setImmediate, typeof clearImmediate, typeof setInterval);
console.log(globalThis.process === process, typeof SLICC_VERSION);
await new Promise((resolve) => setImmediate(resolve));
console.log('immediate ran');
