const zlib = require('zlib');
for (const n of ['brotliCompressSync', 'brotliDecompressSync', 'zstdCompressSync', 'zstdDecompressSync', 'createBrotliCompress', 'createZstdCompress']) {
  try { const r = zlib[n] ? zlib[n](n.startsWith('create') ? undefined : Buffer.from('x')) : 'missing'; console.log(n, 'ok', typeof r); } catch (e) { console.log(n, 'THROW', e instanceof Error, e.name, e.code, Object.keys(e).join(','), '|', e.message.slice(0, 60)); }
}
const cbs = [];
process.on('exit', () => { for (const line of cbs.sort()) console.log(line); });
for (const n of ['brotliCompress', 'zstdCompress']) { try { zlib[n](Buffer.from('x'), (e, r) => cbs.push(`${n} cb ${e ? e.code : 'ok ' + r.length}`)); } catch (e) { console.log(n, 'SYNC THROW', e.code); } }
console.log('versions', typeof process.versions.zlib, typeof process.versions.brotli);
