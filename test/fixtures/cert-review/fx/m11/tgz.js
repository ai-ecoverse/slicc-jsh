const zlib = require('zlib'); const fs = require('fs'); const { pipeline } = require('stream/promises'); const { Writable } = require('stream');
const parse = () => { let buf = Buffer.alloc(0); const names = []; let skip = 0, total = 0, size = 0; return { names, get total() { return total; }, get bytes() { return size; }, w: new Writable({ write(c, e, cb) { buf = Buffer.concat([buf, c]); size += c.length;
  while (true) { if (skip > 0) { const n = Math.min(skip, buf.length); buf = buf.subarray(n); skip -= n; if (skip > 0) break; }
    if (buf.length < 512) break; const h = buf.subarray(0, 512); buf = buf.subarray(512); if (h.every((x) => x === 0)) continue;
    const name = h.subarray(0, 100).toString().replace(/\0.*$/s, ''); const sz = parseInt(h.subarray(124, 136).toString().replace(/\0.*$/s, '').trim() || '0', 8); names.push(`${name}:${sz}`); total++; skip = Math.ceil(sz / 512) * 512; }
  cb(); } }) }; };
(async () => {
  const p = parse(); const t0 = Date.now();
  await pipeline(fs.createReadStream('pkg.tgz', { highWaterMark: 7000 }), zlib.createGunzip(), p.w);
  console.log('tgz entries', p.total, 'tar bytes', p.bytes); console.log(p.names.sort().join('\n'));
  const pj = zlib.gunzipSync(fs.readFileSync('pkg.tgz')); const i = pj.indexOf('"name": "@ai-ecoverse/slicc-jsh"'); console.log('sync gunzip len', pj.length, 'has package.json name', i > 0);
  const u = await new Promise((r) => { const z = zlib.createUnzip(); const out = []; z.on('data', (c) => out.push(c)); z.on('end', () => r(Buffer.concat(out).length)); fs.createReadStream('pkg.tgz').pipe(z); }); console.log('createUnzip pipe len', u);
})().catch((e) => console.log('ERR', e.code, e.message));
