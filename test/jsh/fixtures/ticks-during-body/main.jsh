const log = [];
Promise.resolve().then(() => log.push('microtask'));
process.nextTick(() => log.push('nextTick'));
await new Promise((resolve) => setTimeout(resolve, 20));
console.log(log.join(' '));
const { Readable, Writable, pipeline } = require('stream');
const chunks = [];
for await (const c of Readable.from(['a', 'b'])) chunks.push(c);
console.log('for await', chunks.join(''));
await new Promise((resolve, reject) =>
  pipeline(Readable.from(['x', 'y']), new Writable({ write(c, e, cb) { chunks.push(String(c)); cb(); } }), (err) => (err ? reject(err) : resolve()))
);
console.log('pipeline', chunks.join(''));
