function f() { return new Error('in fn').stack; }
setTimeout(() => { console.log('T1<<' + f() + '>>'); setTimeout(function named() { console.log('T2<<' + new Error('x').stack + '>>'); }, 1); }, 1);
setImmediate(() => console.log('I<<' + new Error('i').stack + '>>'));
const p = new Promise((r) => setTimeout(r, 2)); p.then(() => { setTimeout(() => { const e = new RangeError('deep'); e.code = 'X'; throw e; }, 1); });
