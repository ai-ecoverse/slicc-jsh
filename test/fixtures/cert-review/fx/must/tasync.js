function f() { return new Error('in fn').stack; }
const L = [];
setTimeout(() => { L.push('T1<<' + f() + '>>'); }, 1);
setTimeout(function named() { L.push('T2<<' + new Error('x').stack + '>>'); }, 2);
setImmediate(() => L.push('I<<' + new Error('i').stack + '>>'));
setImmediate(function imnamed() { L.push('I2<<' + new Error('i2').stack + '>>'); });
const iv = setInterval(() => { L.push('IV<<' + new Error('iv').stack + '>>'); clearInterval(iv); }, 3);
setTimeout(async () => { await null; L.push('AT<<' + new Error('after await').stack + '>>'); }, 4);
setTimeout(() => { Promise.resolve().then(() => L.push('PT<<' + new Error('then').stack + '>>')); }, 5);
setTimeout(() => console.log(L.sort().join('\n')), 50);
