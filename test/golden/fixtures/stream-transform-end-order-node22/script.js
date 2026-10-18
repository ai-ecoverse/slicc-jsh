const { Transform, PassThrough, pipeline, Writable } = require('stream');

function run(label, transform, writes, done) {
  const log = [];
  const t = new Transform({ transform, highWaterMark: 4 });
  t.on('data', (c) => log.push(`data ${c}`));
  t.on('end', () => log.push('end'));
  t.on('finish', () => log.push('finish'));
  t.on('close', () => log.push('close'));
  t.on('error', (e) => log.push(`error ${e.code}`));
  // Printed once the last write's callback has run and the ticks it leaves
  // ('error', 'close') have too.
  const print = () =>
    setImmediate(() =>
      setImmediate(() => {
        console.log(`${label}: ${log.join(', ')}`);
        done();
      })
    );
  let i = 0;
  const next = () => {
    const w = writes[i++];
    t.write(w, (err) => {
      log.push(`cb ${w}${err ? ` ${err.code}` : ''}`);
      if (i < writes.length) setImmediate(next);
      else print();
    });
  };
  next();
}

const cases = [
  ['async push(null)', function (chunk, enc, cb) {
    setImmediate(() => {
      this.push(chunk);
      if (`${chunk}` === 'b') this.push(null);
      cb();
    });
  }, ['a', 'b', 'c']],
  ['sync push(null)', function (chunk, enc, cb) {
    this.push(chunk);
    if (`${chunk}` === 'b') this.push(null);
    cb();
  }, ['a', 'b', 'c']],
  ['async push(null), no data', function (chunk, enc, cb) {
    setImmediate(() => {
      if (`${chunk}` === 'a') this.push(null);
      cb();
    });
  }, ['a', 'b']],
  ['async, cb(null, value) after push(null)', function (chunk, enc, cb) {
    setImmediate(() => {
      this.push(null);
      cb(null, 'late');
    });
  }, ['a']],
  ['async push(null) past highWaterMark', function (chunk, enc, cb) {
    setTimeout(() => {
      this.push('xxxxxxxx');
      this.push(null);
      cb();
    }, 1);
  }, ['a']],
  ['async, error after push(null)', function (chunk, enc, cb) {
    setImmediate(() => {
      this.push(null);
      cb(Object.assign(new Error('boom'), { code: 'EBOOM' }));
    });
  }, ['a']],
];

let k = 0;
const step = () => {
  if (k < cases.length) return run(...cases[k++], step);
  // Through pipeline: the source ends, so pipeline's callback runs too.
  const log = [];
  const t = new Transform({
    transform(chunk, enc, cb) {
      setImmediate(() => {
        this.push(chunk);
        if (`${chunk}` === '2') this.push(null);
        cb();
      });
    },
  });
  const src = new PassThrough();
  t.on('end', () => log.push('end'));
  pipeline(src, t, new Writable({ write(c, e, cb) { log.push(`sink ${c}`); cb(); } }), (err) => {
    log.push(`pipeline ${err ? err.code : 'ok'}`);
    setImmediate(() => console.log(`pipeline: ${log.join(', ')}`));
  });
  src.write('1', () => log.push('cb 1'));
  setImmediate(() => src.end('2', () => log.push('cb 2')));
};
step();
