const zlib = require('zlib'); const { promisify } = require('util');
const H = (b) => { let h = 0x811c9dc5; for (const x of b) { h ^= x; h = Math.imul(h, 0x01000193) >>> 0; } return `${b.length}:${h.toString(16)}`; };
const E = (e) => `${e.code ?? e.name} errno=${e.errno} | ${String(e.message).split('\n')[0]}`;
const t = (l, f) => { try { console.log(l, '->', f()); } catch (e) { console.log(l, '-> THROW', E(e)); } };
const text = Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(200) + 'ünïcødé ✓');
const rnd = Buffer.alloc(5000); let s = 1; for (let i = 0; i < rnd.length; i++) { s = (s * 1103515245 + 12345) >>> 0; rnd[i] = s >>> 24; }
for (const [n, data] of [['text', text], ['rnd', rnd], ['empty', Buffer.alloc(0)]]) {
  for (const lvl of [0, 1, 6, 9]) {
    t(`${n} gzip L${lvl}`, () => H(zlib.gzipSync(data, { level: lvl })));
    t(`${n} deflate L${lvl}`, () => H(zlib.deflateSync(data, { level: lvl })));
    t(`${n} deflateRaw L${lvl}`, () => H(zlib.deflateRawSync(data, { level: lvl })));
  }
  t(`${n} deflate strategy HUFFMAN`, () => H(zlib.deflateSync(data, { strategy: zlib.constants.Z_HUFFMAN_ONLY })));
  t(`${n} deflate strategy RLE`, () => H(zlib.deflateSync(data, { strategy: zlib.constants.Z_RLE })));
  t(`${n} deflate windowBits 9 memLevel 1`, () => H(zlib.deflateSync(data, { windowBits: 9, memLevel: 1 })));
  t(`${n} roundtrip all`, () => [zlib.gunzipSync(zlib.gzipSync(data)).equals(data), zlib.inflateSync(zlib.deflateSync(data)).equals(data), zlib.inflateRawSync(zlib.deflateRawSync(data)).equals(data), zlib.unzipSync(zlib.gzipSync(data)).equals(data), zlib.unzipSync(zlib.deflateSync(data)).equals(data)].join(','));
}
t('gzip header bytes', () => [...zlib.gzipSync(text).subarray(0, 10)].join(','));
t('dict', () => { const d = Buffer.from('quick brown fox'); const c = zlib.deflateSync(text, { dictionary: d }); return [H(c), zlib.inflateSync(c, { dictionary: d }).equals(text)].join(' '); });
t('inflate dict missing', () => zlib.inflateSync(zlib.deflateSync(text, { dictionary: Buffer.from('abc') })));
t('corrupt gunzip', () => zlib.gunzipSync(Buffer.from('1f8b0800000000000003ffffffff', 'hex')));
t('not gzip', () => zlib.gunzipSync(Buffer.from('hello world')));
t('corrupt inflate', () => zlib.inflateSync(Buffer.from('78da0102030405', 'hex')));
t('bad checksum', () => { const g = zlib.gzipSync(text); g[g.length - 6] ^= 0xff; return zlib.gunzipSync(g).length; });
t('truncated gunzip sync', () => zlib.gunzipSync(zlib.gzipSync(text).subarray(0, 50)).length);
t('truncated inflate finishFlush SYNC', () => zlib.inflateSync(zlib.deflateSync(text).subarray(0, 60), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).length);
t('maxOutputLength', () => zlib.gunzipSync(zlib.gzipSync(text), { maxOutputLength: 100 }).length);
t('maxOutputLength exact', () => zlib.gunzipSync(zlib.gzipSync(text), { maxOutputLength: text.length }).length);
t('maxOutputLength 0', () => zlib.gunzipSync(zlib.gzipSync(text), { maxOutputLength: 0 }));
t('bad level', () => zlib.deflateSync(text, { level: 42 }));
t('NaN level', () => H(zlib.deflateSync(text, { level: NaN })));
t('bad windowBits', () => zlib.deflateSync(text, { windowBits: 3 }));
t('bad strategy', () => zlib.deflateSync(text, { strategy: 99 }));
t('string input', () => H(zlib.gzipSync('abc')));
t('arraybuffer input', () => H(zlib.deflateSync(new Uint8Array([1, 2, 3]).buffer)));
t('number input', () => zlib.gzipSync(5));
t('concatenated gzip members', () => zlib.gunzipSync(Buffer.concat([zlib.gzipSync('one-'), zlib.gzipSync('two')])).toString());
t('trailing garbage', () => zlib.gunzipSync(Buffer.concat([zlib.gzipSync('x'), Buffer.from('zz')])).toString());
t('crc32', () => [zlib.crc32('hello'), zlib.crc32(Buffer.from('hello')), zlib.crc32('world', zlib.crc32('hello ')), zlib.crc32('hello world'), zlib.crc32(''), zlib.crc32('', 5)].join(','));
t('crc32 bad seed', () => zlib.crc32('x', -1)); t('crc32 bad seed str', () => zlib.crc32('x', 'a')); t('crc32 seed max', () => zlib.crc32('x', 2 ** 32 - 1)); t('crc32 seed 2^32', () => zlib.crc32('x', 2 ** 32));
t('crc32 bad data', () => zlib.crc32(5));
t('constants sample', () => ['Z_NO_FLUSH', 'Z_FINISH', 'Z_BEST_COMPRESSION', 'Z_DEFAULT_STRATEGY', 'Z_DATA_ERROR', 'Z_BUF_ERROR', 'DEFLATE', 'GUNZIP', 'Z_MIN_WINDOWBITS', 'Z_MAX_CHUNK', 'Z_DEFAULT_CHUNK', 'BROTLI_OPERATION_FINISH', 'BROTLI_PARAM_QUALITY', 'ZSTD_e_end'].map((k) => `${k}=${zlib.constants[k]}`).join(' '));
t('constants count', () => Object.keys(zlib.constants).length);
t('legacy top-level constants', () => [zlib.Z_BEST_SPEED, zlib.Z_SYNC_FLUSH, typeof zlib.codes, zlib.codes && zlib.codes.Z_DATA_ERROR].join(','));
t('exports', () => Object.keys(zlib).filter((k) => typeof zlib[k] === 'function').sort().join(','));
t('brotliCompressSync', () => H(zlib.brotliCompressSync(text)));
t('createBrotliDecompress', () => typeof zlib.createBrotliDecompress());
t('instanceof', () => [zlib.createGzip() instanceof zlib.Gzip, zlib.createGzip() instanceof require('stream').Transform, typeof zlib.Gzip, zlib.createGzip().bytesWritten].join(','));
zlib.gzip(text, (e, b) => { console.log('cb gzip', e && e.code, H(b)); zlib.gunzip(b, (e2, r) => console.log('cb gunzip', e2 && e2.code, r.equals(text))); });
zlib.gunzip(Buffer.from('nope'), (e) => console.log('cb gunzip bad', E(e)));
zlib.deflate(text, { level: 9 }, (e, b) => console.log('cb deflate L9', H(b)));
(async () => {
  const pg = promisify(zlib.gzip), pu = promisify(zlib.gunzip);
  console.log('promisify roundtrip', (await pu(await pg(text))).equals(text));
  try { await pu(Buffer.from('xx')); } catch (e) { console.log('promisify bad', E(e)); }
  const { pipeline } = require('stream/promises'); const { Readable, Writable } = require('stream');
  const chunks = []; await pipeline(Readable.from([text.subarray(0, 1000), text.subarray(1000)]), zlib.createGzip({ level: 6 }), new Writable({ write(c, e, cb) { chunks.push(c); cb(); } }));
  const gz = Buffer.concat(chunks); console.log('stream gzip', H(gz), 'sync equal', gz.equals(zlib.gzipSync(text, { level: 6 })));
  const out = []; await pipeline(Readable.from([gz.subarray(0, 7), gz.subarray(7, 100), gz.subarray(100)]), zlib.createGunzip(), new Writable({ write(c, e, cb) { out.push(c); cb(); } })); console.log('stream gunzip', Buffer.concat(out).equals(text));
  try { await pipeline(Readable.from([gz.subarray(0, 60)]), zlib.createGunzip(), new Writable({ write(c, e, cb) { cb(); } })); console.log('stream truncated ok?'); } catch (e) { console.log('stream truncated', E(e)); }
  try { await pipeline(Readable.from([Buffer.from('garbage-data-here')]), zlib.createInflate(), new Writable({ write(c, e, cb) { cb(); } })); } catch (e) { console.log('stream corrupt', E(e)); }
  const d = zlib.createDeflate(); const parts = []; d.on('data', (c) => parts.push(c)); d.write('abc'); d.flush(zlib.constants.Z_SYNC_FLUSH, () => { console.log('flush partial inflates to', zlib.inflateSync(Buffer.concat(parts), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString()); d.end(); });
  const g = zlib.createGzip(); g.on('data', () => {}); g.on('end', () => console.log('bytesWritten', g.bytesWritten)); g.end(text);
  const cp = await new Promise((r) => { const z = zlib.createGzip(); z.on('error', (e) => r('err ' + E(e))); z.close(() => r('closed')); }); console.log('close', cp);
  try { zlib.createGunzip().write(5); } catch (e) { console.log('stream write number', E(e)); }
  const p = await new Promise((r) => zlib.createDeflate({ level: 'x' }) && r('no throw')).catch((e) => E(e)); console.log('createDeflate bad level', p);
})().catch((e) => console.log('async THROW', E(e)));
