const D=(v)=>{if(v===undefined)return'undefined';if(typeof v==='function')return'[function]';if(typeof v==='bigint')return`${v}n`;if(v&&typeof v.then==='function'){v.then(()=>{},()=>{});return'[Promise]'}if(typeof Buffer!=='undefined'&&Buffer.isBuffer&&Buffer.isBuffer(v))return`[Buffer ${v.length}]`;if(v instanceof Uint8Array)return`[Uint8Array ${v.length}]`;try{return JSON.stringify(v)}catch{return String(v)}},E=(e)=>`THROW ${e&&e.name}${e&&e.code?` ${e.code}`:''}: ${String(e&&e.message).split('\n')[0]}`,show=(k,f)=>{let s;try{s=D(f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)},showA=async(k,f)=>{let s;try{s=D(await f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)};
const zlib = require('zlib');
show('gzip round trip', () => zlib.gunzipSync(zlib.gzipSync('hello zlib')).toString());
show('deflateSync bytes', () => zlib.deflateSync('abc').toString('base64'));
show('inflateSync', () => zlib.inflateSync(zlib.deflateSync('inflate me')).toString());
show('deflateRawSync', () => zlib.inflateRawSync(zlib.deflateRawSync('raw')).toString());
show('gunzipSync returns Buffer', () => Buffer.isBuffer(zlib.gunzipSync(zlib.gzipSync('x'))));
show('brotli', () => zlib.brotliDecompressSync(zlib.brotliCompressSync('brotli')).toString());
await showA('gzip callback', () => new Promise((r) => zlib.gzip('cb', (err, buf) => r([err, zlib.gunzipSync(buf).toString()]))));
await showA('createGunzip stream', () => new Promise((resolve, reject) => {
  const g = zlib.createGunzip();
  let s = '';
  g.on('data', (d) => { s += d; });
  g.on('end', () => resolve(s));
  g.on('error', reject);
  g.end(zlib.gzipSync('streamed'));
}));
show('constants', () => typeof zlib.constants.Z_BEST_COMPRESSION);
