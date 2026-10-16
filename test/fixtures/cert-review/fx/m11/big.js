const zlib = require('zlib'); const { pipeline } = require('stream/promises'); const { Readable, Writable } = require('stream');
const MB = 10; const chunk = Buffer.alloc(64 * 1024); let s = 7;
function* gen() { for (let i = 0; i < MB * 16; i++) { for (let j = 0; j < chunk.length; j++) { s = (s * 1103515245 + 12345) >>> 0; chunk[j] = 97 + ((s >>> 27) & 7); } yield Buffer.from(chunk); } }
(async () => {
  const t0 = Date.now(); let gz = []; let gzLen = 0; let crc = 0; let inLen = 0;
  await pipeline(Readable.from(gen()), new (require('stream').Transform)({ transform(c, e, cb) { crc = zlib.crc32(c, crc); inLen += c.length; cb(null, c); } }), zlib.createGzip(), new Writable({ write(c, e, cb) { gz.push(c); gzLen += c.length; cb(); } }));
  const t1 = Date.now(); let outLen = 0; let crc2 = 0;
  await pipeline(Readable.from(gz), zlib.createGunzip(), new Writable({ write(c, e, cb) { outLen += c.length; crc2 = zlib.crc32(c, crc2); cb(); } }));
  const t2 = Date.now();
  console.log(`in ${inLen} gz ${gzLen} out ${outLen} crc ${crc === crc2} ${crc}`);
  console.error(`TIMING gzip ${t1 - t0} ms gunzip ${t2 - t1} ms`);
  const t3 = Date.now(); const g = zlib.gzipSync(Buffer.concat(gz.length ? [zlib.gunzipSync(Buffer.concat(gz))] : [])); console.error(`TIMING sync roundtrip ${Date.now() - t3} ms`); console.log('sync gz equals stream gz', g.equals(Buffer.concat(gz)));
})();
