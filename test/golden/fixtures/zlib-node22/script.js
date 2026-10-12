const zlib = require('zlib');
const { promisify } = require('util');
const { pipeline, Readable, Writable } = require('stream');
const show = (label, f) => {
  let v;
  try {
    v = f();
    if (Buffer.isBuffer(v)) v = `<${v.length}> ${v.toString('base64')}`;
    v = v === undefined ? 'undefined' : JSON.stringify(v);
  } catch (e) {
    v = `THROW ${e.name} ${e.code} ${e.errno} ${JSON.stringify(e.message)}`;
  }
  console.log(`${label}: ${v}`);
};
const text = 'hello hello hello zlib '.repeat(40);
for (const level of [0, 1, 6, 9]) {
  show(`deflateSync level ${level}`, () => zlib.deflateSync(text, { level }));
  // Byte 9 is the OS the gzip header names (3 Linux, 19 macOS).
  show(`gzipSync level ${level}`, () => Object.assign(zlib.gzipSync(text, { level }), { 9: 0 }));
  show(`deflateRawSync level ${level}`, () => zlib.deflateRawSync(text, { level }));
}
show('deflateSync strategy RLE', () => zlib.deflateSync(text, { strategy: zlib.constants.Z_RLE }));
show('deflateSync memLevel 1 windowBits 9', () => zlib.deflateSync(text, { memLevel: 1, windowBits: 9 }));
show('inflateSync', () => zlib.inflateSync(zlib.deflateSync(text)).toString() === text);
show('gunzipSync', () => zlib.gunzipSync(zlib.gzipSync(text)).toString() === text);
show('unzipSync gzip', () => zlib.unzipSync(zlib.gzipSync('u')).toString());
show('unzipSync deflate', () => zlib.unzipSync(zlib.deflateSync('u')).toString());
show('inflateRawSync', () => zlib.inflateRawSync(zlib.deflateRawSync('raw')).toString());
show('Uint8Array input', () => zlib.inflateSync(new Uint8Array(zlib.deflateSync('typed'))).toString());
show('ArrayBuffer input', () => {
  const d = zlib.deflateSync('ab');
  return zlib.inflateSync(d.buffer.slice(d.byteOffset, d.byteOffset + d.length)).toString();
});
show('info', () => {
  const r = zlib.deflateSync('i', { info: true });
  return [Buffer.isBuffer(r.buffer), r.engine instanceof zlib.Deflate];
});
show('dictionary', () => {
  const dictionary = Buffer.from('hello zlib dictionary');
  const d = zlib.deflateSync(text, { dictionary });
  return [d.toString('base64').slice(0, 24), zlib.inflateSync(d, { dictionary }).toString() === text];
});
show('missing dictionary', () => zlib.inflateSync(zlib.deflateSync(text, { dictionary: Buffer.from('dict') })));
show('incorrect header', () => zlib.inflateSync(Buffer.from('not zlib data')));
show('truncated gzip', () => zlib.gunzipSync(zlib.gzipSync(text).subarray(0, 20)));
show('bad input type', () => zlib.deflateSync(42));
show('bad level', () => zlib.deflateSync('x', { level: 11 }));
show('bad windowBits', () => zlib.deflateSync('x', { windowBits: 'w' }));
show('bad chunkSize', () => zlib.deflateSync('x', { chunkSize: 10 }));
show('level NaN is the default', () => zlib.deflateSync('x', { level: NaN }).length);
show('maxOutputLength', () => zlib.inflateSync(zlib.deflateSync('x'.repeat(100)), { maxOutputLength: 10 }));
show('bad maxOutputLength', () => zlib.inflateSync(zlib.deflateSync('x'), { maxOutputLength: 0 }));
show('crc32 seed 1.5', () => zlib.crc32('a', 1.5));
show('crc32 seed -1', () => zlib.crc32('a', -1));
show('crc32 seed 2**32', () => zlib.crc32('a', 2 ** 32));
show('crc32 seed string', () => zlib.crc32('a', 'x'));
show('crc32 data number', () => zlib.crc32(1));
show('crc32', () => [zlib.crc32('hello'), zlib.crc32(Buffer.from('world'), zlib.crc32('hello ')), zlib.crc32('')]);
show('constants', () => [zlib.constants.Z_BEST_COMPRESSION, zlib.constants.Z_SYNC_FLUSH, zlib.constants.Z_DEFAULT_CHUNK, zlib.constants.Z_MAX_CHUNK]);
show('codes', () => [zlib.codes.Z_DATA_ERROR, zlib.codes['-3']]);
show('classes', () => ['Deflate', 'Inflate', 'Gzip', 'Gunzip', 'DeflateRaw', 'InflateRaw', 'Unzip'].map((n) => typeof zlib[n]));
(async () => {
  console.log('callback', await new Promise((r) => zlib.gzip(text, (err, buf) => r([err, zlib.gunzipSync(buf).toString() === text]))));
  console.log('callback maxOutputLength', await new Promise((r) => zlib.gunzip(zlib.gzipSync('y'.repeat(50)), { maxOutputLength: 5 }, (e) => r([e.code, e.message]))));
  console.log('promisify', (await promisify(zlib.deflate)('p')).toString('base64'));
  console.log('callback error', await new Promise((r) => zlib.inflate(Buffer.from('nope'), (err) => r([err.code, err.errno, err.message]))));
  const chunks = [];
  await new Promise((resolve, reject) =>
    pipeline(
      Readable.from([Buffer.from(text.slice(0, 100)), Buffer.from(text.slice(100))]),
      zlib.createGzip(),
      zlib.createGunzip(),
      new Writable({ write(c, e, cb) { chunks.push(c); cb(); } }),
      (err) => (err ? reject(err) : resolve())
    )
  );
  console.log('stream pipeline', Buffer.concat(chunks).toString() === text);
  const def = zlib.createDeflate();
  const out = [];
  def.on('data', (c) => out.push(c));
  def.write('flushed');
  await new Promise((r) => def.flush(r));
  console.log('flush', Buffer.concat(out).toString('base64'));
  def.end();
  await new Promise((r) => def.on('close', r));
  console.log('closed', def._handle);
  const g = zlib.createGunzip();
  g.on('error', (e) => console.log('stream error', e.code, e.errno, e.message));
  g.end(Buffer.from('not gzip'));
})();
