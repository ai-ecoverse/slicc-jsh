const fs = require('fs'), os = require('os'), path = require('path');
const f = path.join(os.tmpdir(), 'm34rs-' + process.pid); fs.writeFileSync(f, 'héllo wörld');
const run = (l, opts) => new Promise((r) => { const out = []; const s = fs.createReadStream(f, opts); s.on('data', (c) => out.push(typeof c === 'string' ? 'str:' + c : 'buf:' + c.length)).on('end', () => { console.log(l, s.readableEncoding, out.join('|')); r(); }).on('error', (e) => { console.log(l, 'error', e.code); r(); }); });
(async () => {
  await run("'utf8'", 'utf8');
  await run("'latin1'", 'latin1');
  await run('{encoding:hex}', { encoding: 'hex' });
  await run('none', undefined);
  await run("'bogus'", 'bogus').catch((e) => console.log('bogus throws', e.code));
  const w = fs.createWriteStream(f, 'latin1'); w.end('ÿ', () => { console.log('ws latin1 bytes', [...fs.readFileSync(f)]); fs.unlinkSync(f); });
})().catch((e) => console.log('caught', e.code));
