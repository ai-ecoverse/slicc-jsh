// #99: zlib callback forms call back with errors (not throw); brotli/zstd unavailable via callback
const zlib = require('zlib');
const show = (l) => (err, r) => console.log(l, err ? `${err.code ?? err.name}: ${String(err.message).slice(0, 60)}` : `ok ${r.length}`);
zlib.inflate(Buffer.from('not zlib'), show('inflate bad'));
zlib.gunzip(Buffer.from([1, 2, 3]), show('gunzip bad'));
zlib.deflate('abc', show('deflate ok'));
zlib.unzip(zlib.gzipSync('xyz'), show('unzip ok'));
try { zlib.brotliCompress('abc', (err, r) => console.log('brotliCompress cb', err ? err.code : 'ok ' + r.length)); } catch (e) { console.log('brotliCompress threw', e.code); }
try { zlib.brotliDecompress(Buffer.from([1]), (err) => console.log('brotliDecompress cb', err ? 'err' : 'ok')); } catch (e) { console.log('brotliDecompress threw', e.code); }
console.log('versions.zlib type', typeof process.versions.zlib);
