const fs = require('fs');
const os = require('os');
const path = require('path');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cpg-'));
const real = fs.realpathSync(work);
process.chdir(work);
const norm = (s) => String(s).split(real).join('$W').split(work).join('$W');
const show = (label, f) => {
  let v;
  try {
    v = f();
    v = v === undefined ? 'undefined' : norm(JSON.stringify(v));
  } catch (e) {
    v = `THROW ${e.name} ${e.code} ${e.syscall} ${norm(JSON.stringify(e.message))}`;
  }
  console.log(`${label}: ${v}`);
};
const kind = (p) => {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!st) return 'missing';
  if (st.isSymbolicLink()) return `link -> ${norm(fs.readlinkSync(p))}`;
  if (st.isDirectory()) return `dir [${fs.readdirSync(p).sort()}]`;
  return `file ${JSON.stringify(fs.readFileSync(p, 'utf8'))}`;
};
const tree = (p) => {
  const out = [];
  const walk = (dir, rel, depth) => {
    if (depth > 6) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) out.push(`${r}@`);
      else if (st.isDirectory()) { out.push(`${r}/`); walk(full, r, depth + 1); }
      else out.push(r);
    }
  };
  walk(p, '', 0);
  return out.join(' ');
};
fs.mkdirSync('outside/kd', { recursive: true });
fs.writeFileSync('outside/keep', 'k');
fs.mkdirSync('c/s', { recursive: true });
fs.writeFileSync('c/x', 'x');
fs.writeFileSync('c/s/y', 'y');
fs.symlinkSync('../outside', 'c/ol');
fs.symlinkSync('x', 'c/xl');
show('cpSync with symlinks (default)', () => fs.cpSync('c', 'c3', { recursive: true }));
for (const n of ['ol', 'xl']) console.log('  c3', n, kind(`c3/${n}`));
show('cpSync dereference', () => fs.cpSync('c', 'c4', { recursive: true, dereference: true }));
for (const n of ['ol', 'xl']) console.log('  c4', n, kind(`c4/${n}`));
show('cpSync verbatimSymlinks', () => fs.cpSync('c', 'c5', { recursive: true, verbatimSymlinks: true }));
for (const n of ['ol', 'xl']) console.log('  c5', n, kind(`c5/${n}`));
show('cpSync file symlink alone', () => fs.cpSync('c/xl', 'xl-copy'));
console.log('  xl-copy', kind('xl-copy'));
show('cpSync dir symlink alone (recursive)', () => fs.cpSync('c/ol', 'ol-copy', { recursive: true }));
console.log('  ol-copy', kind('ol-copy'));
show('cpSync filter with symlinks', () => fs.cpSync('c', 'c6', { recursive: true, filter: (s) => !s.endsWith('/x') }));
console.log('  c6', tree('c6'), '| ol', kind('c6/ol'), '| xl', kind('c6/xl'));
fs.mkdirSync('l/s', { recursive: true });
fs.writeFileSync('l/s/f', 'f');
fs.symlinkSync('..', 'l/s/up');
show('cpSync symlink loop', () => fs.cpSync('l', 'lout', { recursive: true }));
console.log('  lout', tree('lout'), '| up', kind('lout/s/up'));
fs.mkdirSync('cd');
fs.writeFileSync('cd/f', 'f');
fs.symlinkSync('nowhere', 'cd/dang');
show('cpSync dangling symlink', () => fs.cpSync('cd', 'cd2', { recursive: true }));
console.log('  cd2', tree('cd2'), '| dang', kind('cd2/dang'));
show('cpSync existing dest errorOnExist', () => fs.cpSync('c/x', 'c/s/y', { force: false, errorOnExist: true }));
show('cpSync existing dest force false', () => fs.cpSync('c/x', 'c/s/y', { force: false }));
console.log('  y', kind('c/s/y'));
show('cpSync existing dest (force)', () => fs.cpSync('c/x', 'c/s/y'));
console.log('  y', kind('c/s/y'));
show('cpSync dir onto file', () => fs.cpSync('c/s', 'c/x', { recursive: true }));
show('cpSync file onto dir', () => fs.cpSync('c/x', 'c/s'));
show('cpSync missing src', () => fs.cpSync('nope', 'c7'));
show('cpSync into a missing parent', () => fs.cpSync('c/x', 'new/deep/x'));
console.log('  new', tree('new'));
show('cpSync tree into existing dest', () => fs.cpSync('c', 'c3', { recursive: true }));
console.log('  c3', tree('c3'));
console.log('outside', tree('outside'));
show('realpathSync link', () => fs.realpathSync('c/ol'));
show('realpathSync loop', () => fs.realpathSync('l/s/up'));
show('realpathSync file link', () => fs.realpathSync('c/xl'));
show('realpathSync dangling', () => fs.realpathSync('cd/dang'));
show('realpathSync.native', () => typeof fs.realpathSync.native);
process.chdir(os.tmpdir());
fs.rmSync(work, { recursive: true, force: true });
