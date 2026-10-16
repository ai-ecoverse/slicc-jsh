const fs = require('fs'); const fsp = require('fs/promises');
(async () => {
  const t = async (l, f) => { try { const v = await f(); console.log(l, JSON.stringify(v === undefined ? 'undef' : v)); } catch (e) { console.log(l, 'throws', e.code); } };
  await t('fsp.writeFile /dev/null', () => fsp.writeFile('/dev/null', 'x'));
  await t('fsp.readFile /dev/null', async () => (await fsp.readFile('/dev/null')).length);
  await t('fsp.appendFile /dev/stdout', () => fsp.appendFile('/dev/stdout', 'P-APPEND\n'));
  await t('FileHandle.read /dev/zero', async () => { const h = await fsp.open('/dev/zero', 'r'); const { bytesRead, buffer } = await h.read(Buffer.alloc(1000, 7), 0, 1000, null); await h.close(); return [bytesRead, buffer.every((x) => x === 0)]; });
  await t('cb writeFile /dev/null', () => new Promise((r, j) => fs.writeFile('/dev/null', 'y', (e) => (e ? j(e) : r()))));
  await t('cb readFile /dev/null', () => new Promise((r, j) => fs.readFile('/dev/null', (e, b) => (e ? j(e) : r(b.length)))));
  process.stdout.write('ORDER-1\n'); fs.appendFileSync('/dev/stdout', 'ORDER-2\n'); process.stdout.write('ORDER-3\n');
  const ws = fs.createWriteStream('/dev/stdout'); ws.write('STREAM-1\n'); ws.end('STREAM-2\n'); await new Promise((r) => ws.on('finish', r));
  await t('createReadStream /dev/zero 100 KB', () => new Promise((r) => { let n = 0; const rs = fs.createReadStream('/dev/zero', { end: 99999 }); rs.on('data', (d) => (n += d.length)); rs.on('end', () => r(n)); }));
})();
