const { StringDecoder } = require('string_decoder'); const fs = require('fs'); const { PassThrough, Readable, Writable, Transform, pipeline } = require('stream');
const out = []; const t = (n, f) => { try { out.push(`${n}: ${f()}`); } catch (e) { out.push(`${n}: ${e.name} ${e.message}`); } };
const chk = (n, c) => t(n, () => [c instanceof Buffer, Buffer.isBuffer(c), c.equals(new Uint8Array(c)), c.constructor === Buffer].join(','));
const d = new StringDecoder('utf8'); d.write(Buffer.from('E1', 'hex')); chk('StringDecoder.lastChar', d.lastChar);
fs.writeFileSync('/tmp/bid', 'xyz');
const p = new PassThrough(); p.on('data', (c) => chk('PassThrough chunk', c)); p.end('a');
const r = Readable.from(['s1', 's2'], { objectMode: false }); r.once('data', (c) => chk('Readable.from(strings) chunk', c));
const got = [];
pipeline(fs.createReadStream('/tmp/bid'), new Transform({ transform(c, e, cb) { chk('pipeline transform input', c); cb(null, c); } }), new Writable({ write(c, e, cb) { chk('pipeline sink chunk', c); got.push(c); cb(); } }), (err) => {
  t('pipeline err', () => String(err)); t('Buffer.concat(got)', () => Buffer.concat(got).toString());
  fs.createReadStream('/tmp/bid').on('data', (c) => chk('fs.createReadStream chunk', c)).on('close', () => console.log(out.sort().join('\n')));
});
