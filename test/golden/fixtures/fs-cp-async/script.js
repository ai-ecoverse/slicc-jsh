const fs = require('fs');
const os = require('os');
const path = require('path');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cpg-'));
const real = fs.realpathSync(work);
process.chdir(work);
const norm = (s) => String(s).split(real).join('$W').split(work).join('$W');
const kind = (p) => {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!st) return 'missing';
  if (st.isSymbolicLink()) return `link -> ${norm(fs.readlinkSync(p))}`;
  if (st.isDirectory()) return `dir [${fs.readdirSync(p).sort()}]`;
  return `file ${JSON.stringify(fs.readFileSync(p, 'utf8'))}`;
};
(async () => {
  const showA = async (label, f) => {
    let v;
    try { v = await f(); v = v === undefined ? 'undefined' : norm(JSON.stringify(v)); }
    catch (e) { v = `THROW ${e.name} ${e.code} ${e.syscall} ${e.errno} ${norm(JSON.stringify(e.message))}`; }
    console.log(`${label}: ${v}`);
  };
  fs.mkdirSync('outside');
  fs.mkdirSync('c/s', { recursive: true });
  fs.writeFileSync('c/x', 'x'); fs.writeFileSync('c/s/y', 'y');
  fs.symlinkSync('../outside', 'c/ol'); fs.symlinkSync('x', 'c/xl');
  const p = fs.promises;
  await showA('promises.cp default', () => p.cp('c', 'p3', { recursive: true }));
  for (const n of ['ol', 'xl']) console.log('  p3', n, kind(`p3/${n}`));
  await showA('promises.cp dereference', () => p.cp('c', 'p4', { recursive: true, dereference: true }));
  for (const n of ['ol', 'xl']) console.log('  p4', n, kind(`p4/${n}`));
  await showA('promises.cp verbatim', () => p.cp('c', 'p5', { recursive: true, verbatimSymlinks: true }));
  for (const n of ['ol', 'xl']) console.log('  p5', n, kind(`p5/${n}`));
  await showA('promises.cp onto itself', () => p.cp('c', 'c', { recursive: true }));
  await showA('promises.cp into itself', () => p.cp('c', 'c/s/in', { recursive: true }));
  await showA('promises.cp dir no recursive', () => p.cp('c', 'p6'));
  await showA('promises.cp dir onto file', () => p.cp('c/s', 'c/x', { recursive: true }));
  await showA('promises.cp file onto dir', () => p.cp('c/x', 'c/s'));
  await showA('promises.cp errorOnExist', () => p.cp('c/x', 'c/s/y', { force: false, errorOnExist: true }));
  await showA('promises.cp missing', () => p.cp('nope', 'x2'));
  await showA('cb cp default', () => new Promise((res, rej) => fs.cp('c', 'p7', { recursive: true }, (e) => (e ? rej(e) : res()))));
  console.log('  p7 ol', kind('p7/ol'));
  fs.mkdirSync('l/s', { recursive: true }); fs.writeFileSync('l/s/f', 'f'); fs.symlinkSync('..', 'l/s/up');
  await showA('promises.cp loop', () => p.cp('l', 'lp', { recursive: true }));
  console.log('  up', kind('lp/s/up'));
  const sync = (label, f) => { try { f(); console.log(label, 'ok'); } catch (e) { console.log(label, `THROW ${e.name} ${e.code} ${e.syscall} ${e.errno} ${norm(JSON.stringify(e.message))}`); } };
  sync('cpSync onto itself', () => fs.cpSync('c', 'c', { recursive: true }));
  sync('cpSync into itself', () => fs.cpSync('c', 'c/s/in', { recursive: true }));
  sync('cpSync dir no recursive', () => fs.cpSync('c', 'p8'));
  sync('cpSync filter promise', () => fs.cpSync('c', 'p9', { recursive: true, filter: async () => true }));
  fs.writeFileSync('c/s/x', 'old');
  sync('cpSync tree file exists force false', () => fs.cpSync('c', 'c3b', { recursive: true }));
  sync('cpSync tree into existing, errorOnExist', () => fs.cpSync('c', 'c3b', { recursive: true, force: false, errorOnExist: true }));
  sync('cpSync tree into existing, force false', () => fs.cpSync('c', 'c3b', { recursive: true, force: false }));
  process.chdir(os.tmpdir());
  fs.rmSync(work, { recursive: true, force: true });
})();
