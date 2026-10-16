const fs = require('fs'); const { fresh, t } = require('./h.cjs');
const d = fresh('w-fdm'); const f = `${d}/f`; fs.writeFileSync(f, 'hello');
let fd = fs.openSync(f, 'r'); t('write to r fd', () => fs.writeSync(fd, 'x')); t('writeFileSync r fd', () => fs.writeFileSync(fd, 'x')); t('read r fd', () => { const b = Buffer.alloc(9); return [fs.readSync(fd, b, 0, 9, 0), b.toString('utf8', 0, 5)]; }); fs.closeSync(fd);
fd = fs.openSync(f, 'w'); t('read w fd', () => fs.readSync(fd, Buffer.alloc(4), 0, 4, 0)); t('readFileSync w fd', () => fs.readFileSync(fd, 'utf8')); t('write w fd', () => fs.writeSync(fd, 'new')); fs.closeSync(fd); console.log('  after w:', JSON.stringify(fs.readFileSync(f, 'utf8')));
fd = fs.openSync(f, 'a'); t('write a fd at pos 0', () => fs.writeSync(fd, '+A', 0)); t('read a fd', () => fs.readSync(fd, Buffer.alloc(4), 0, 4, 0)); fs.closeSync(fd); console.log('  after a:', JSON.stringify(fs.readFileSync(f, 'utf8')));
fd = fs.openSync(f, 'a+'); t('read a+ fd', () => { const b = Buffer.alloc(9); const n = fs.readSync(fd, b, 0, 9, 0); return b.toString('utf8', 0, n); }); fs.writeSync(fd, '!'); fs.closeSync(fd); console.log('  after a+:', JSON.stringify(fs.readFileSync(f, 'utf8')));
fd = fs.openSync(f, 'r+'); fs.writeSync(fd, 'N'); t('read r+ fd', () => { const b = Buffer.alloc(9); const n = fs.readSync(fd, b, 0, 9, 0); return b.toString('utf8', 0, n); }); fs.closeSync(fd);
t('open wx existing', () => fs.openSync(f, 'wx')); t('open ax existing', () => fs.openSync(f, 'ax'));
t('writeFileSync flag wx existing', () => fs.writeFileSync(f, 'z', { flag: 'wx' })); console.log('  still:', JSON.stringify(fs.readFileSync(f, 'utf8')));
t('writeFileSync flag wx new', () => fs.writeFileSync(`${d}/g`, 'g', { flag: 'wx' }));
t('writeFileSync flag a', () => fs.writeFileSync(`${d}/g`, 'G', { flag: 'a' })); console.log('  g:', fs.readFileSync(`${d}/g`, 'utf8'));
t('appendFileSync flag w', () => fs.appendFileSync(`${d}/g`, 'w', { flag: 'w' })); console.log('  g:', fs.readFileSync(`${d}/g`, 'utf8'));
t('open r missing', () => fs.openSync(`${d}/missing`, 'r')); t('open dir w', () => fs.openSync(d, 'w'));
fd = fs.openSync(f, 'r'); fs.readSync(fd, Buffer.alloc(2), 0, 2, null); t('readFileSync(fd) from position', () => fs.readFileSync(fd, 'utf8')); fs.closeSync(fd);
fd = fs.openSync(`${d}/h`, 'w'); fs.writeFileSync(fd, 'one'); fs.writeFileSync(fd, 'two'); fs.appendFileSync(fd, '3'); fs.closeSync(fd); console.log('  h via fd writes:', fs.readFileSync(`${d}/h`, 'utf8'));
t('writeSync closed fd', () => fs.writeSync(fd, 'x'));
const p = require('fs/promises');
(async () => {
  const h = await p.open(f, 'r'); try { await h.write('x'); console.log('fh write r -> ok'); } catch (e) { console.log('fh write r -> THROW', e.code, e.syscall); } console.log('fh readFile', JSON.stringify(await h.readFile('utf8'))); await h.sync(); await h.datasync(); await h.close();
  const h2 = await p.open(f, 'w'); try { await h2.read(Buffer.alloc(3), 0, 3, 0); console.log('fh read w -> ok'); } catch (e) { console.log('fh read w -> THROW', e.code, e.syscall); } await h2.close();
  try { await p.open(f, 'wx'); } catch (e) { console.log('fh open wx', e.code, e.syscall, e.path); }
  fs.writeSync(1, 'writeSync(1) ok\n'); fs.writeFileSync(1, 'writeFileSync(1) ok\n'); fs.writeFileSync(2, 'to stderr\n');
})();
