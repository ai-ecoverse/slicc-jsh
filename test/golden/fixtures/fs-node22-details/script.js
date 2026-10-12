const fs = require('fs');
const os = require('os');
const path = require('path');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fsd-'));
process.chdir(work);
const show = (label, f) => {
  let v;
  try {
    v = f();
    v = v === undefined ? 'undefined' : JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x));
  } catch (e) {
    v = `THROW ${e.name} ${e.code} ${e.syscall} ${JSON.stringify(e.message)}`;
  }
  console.log(`${label}: ${v}`);
};
fs.writeFileSync('e.bin', Buffer.from([0xc3, 0xa9, 0x80, 0x41]));
show('read ascii', () => fs.readFileSync('e.bin', 'ascii'));
show('read encoding buffer', () => fs.readFileSync('e.bin', 'buffer'));
show('read bogus encoding', () => fs.readFileSync('e.bin', 'bogus'));
show('read { encoding: bogus }', () => fs.readFileSync('e.bin', { encoding: 'bogus' }));
show('write bogus encoding', () => fs.writeFileSync('w.txt', 'x', 'bogus'));
show('readdir bogus encoding', () => fs.readdirSync('.', { encoding: 'bogus' }));
show('readdir buffer dirents', () => fs.readdirSync('.', { encoding: 'buffer', withFileTypes: true }).map((d) => Buffer.isBuffer(d.name)));
fs.writeFileSync('a.txt', 'old');
show('appendFileSync flag w', () => (fs.appendFileSync('a.txt', 'new', { flag: 'w' }), fs.readFileSync('a.txt', 'utf8')));
show('appendFileSync flag wx', () => fs.appendFileSync('a.txt', 'x', { flag: 'wx' }));
show('writeFileSync flag r+', () => (fs.writeFileSync('a.txt', 'N', { flag: 'r+' }), fs.readFileSync('a.txt', 'utf8')));
show('writeFileSync flag r+ missing', () => fs.writeFileSync('missing.txt', 'N', { flag: 'r+' }));
show('mkdtempSync missing parent', () => fs.mkdtempSync('nope/x-'));
show('nope created', () => fs.existsSync('nope'));
show('copyFileSync mode 8', () => fs.copyFileSync('a.txt', 'b.txt', 8));
show('copyFileSync mode string', () => fs.copyFileSync('a.txt', 'b.txt', 'x'));
fs.mkdirSync('od/x', { recursive: true });
fs.writeFileSync('od/x/y', '');
show('opendirSync recursive', () => {
  const d = fs.opendirSync('od', { recursive: true });
  const names = [];
  for (let e = d.readSync(); e; e = d.readSync()) names.push(`${e.parentPath}|${e.name}`);
  d.closeSync();
  return names.sort();
});
show('Dir double closeSync', () => {
  const d = fs.opendirSync('od');
  d.closeSync();
  d.closeSync();
});
show('opendirSync missing', () => fs.opendirSync('missing'));
show('stat bigint', () => {
  const st = fs.statSync('a.txt', { bigint: true });
  return [typeof st.size, typeof st.mtimeMs, typeof st.mtimeNs, st.isFile(), st.size, Object.keys(st).sort().join(',')];
});
show('stat keys', () => Object.keys(fs.statSync('a.txt')).sort().join(','));
show('stat mtime is a Date', () => fs.statSync('a.txt').mtime instanceof Date);
show('symlinkSync existing', () => (fs.symlinkSync('a.txt', 'l'), fs.symlinkSync('a.txt', 'l')));
(async () => {
  const p = fs.promises;
  const showA = async (label, f) => {
    let v;
    try {
      v = await f();
      v = v === undefined ? 'undefined' : JSON.stringify(v);
    } catch (e) {
      v = `THROW ${e.name} ${e.code} ${e.syscall} ${JSON.stringify(e.message)}`;
    }
    console.log(`${label}: ${v}`);
  };
  await showA('promises.realpath missing', () => p.realpath('zz'));
  await showA('realpathSync.native missing', () => fs.realpathSync.native('zz'));
  await showA('realpathSync missing (code, syscall)', () => {
    try {
      return fs.realpathSync('zz');
    } catch (e) {
      return [e.code, e.syscall];
    }
  });
  await showA('promises.appendFile flag wx', () => p.appendFile('a.txt', 'x', { flag: 'wx' }));
  process.chdir(os.tmpdir());
  fs.rmSync(work, { recursive: true, force: true });
})();
