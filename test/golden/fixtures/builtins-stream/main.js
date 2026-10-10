const { Readable, Writable } = require('stream');
const r = new Readable({ read() {} });
r.push(Buffer.from('hi'));
r.push(null);
console.log(r.read().toString());
console.log(r.read());
const w = new Writable({
  write(chunk, enc, cb) {
    console.log('w', chunk.toString());
    cb();
  },
});
w.write('ok');
w.end();
