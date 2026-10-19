// Only unref'd timers and promise jobs left: the jobs all run, then
// 'beforeExit', and the unref'd timeout, immediate and interval never do.
setTimeout(() => console.log('unexpected timeout'), 0).unref();
setImmediate(() => console.log('unexpected immediate')).unref();
setInterval(() => console.log('unexpected interval'), 0).unref();
let p = Promise.resolve();
for (let i = 0; i < 100; i++) p = p.then(() => {});
p.then(() => console.log('chain done'));
process.on('beforeExit', () => console.log('beforeExit'));
process.on('exit', (code) => console.log('exit', code));
