import fs from 'node:fs'; import p from 'node:fs/promises'; import h from './h.cjs';
const d = h.fresh('w-cpl'); const o = h.fresh('w-cpl-out'); fs.writeFileSync(`${o}/of`, 'O'); fs.mkdirSync(`${o}/osub`); fs.writeFileSync(`${o}/osub/og`, 'G');
fs.mkdirSync(`${d}/src/s`, { recursive: true }); fs.writeFileSync(`${d}/src/x`, 'x'); fs.writeFileSync(`${d}/src/s/y`, 'y');
fs.symlinkSync('../../w-cpl-out', `${d}/src/dl`); fs.symlinkSync('x', `${d}/src/fl`); fs.symlinkSync('..', `${d}/src/s/up`); fs.symlinkSync('nowhere', `${d}/src/dang`);
const cwd = process.cwd(); const show = (root) => { const out = []; const walk = (rel) => { for (const n of fs.readdirSync(`${root}/${rel}`).sort()) { const q = rel ? `${rel}/${n}` : n; const st = fs.lstatSync(`${root}/${q}`); if (st.isSymbolicLink()) out.push(`${q}->${fs.readlinkSync(`${root}/${q}`).replace(cwd, 'CWD')}`); else if (st.isDirectory()) { out.push(q + '/'); walk(q); } else out.push(q); } }; try { walk(''); } catch (e) { out.push('ERR ' + e.code); } return out.join(' '); };
const forms = { cpSync: (a, b, o) => fs.cpSync(a, b, o), cb: (a, b, o) => new Promise((r, j) => fs.cp(a, b, o, (e) => (e ? j(e) : r()))), promises: (a, b, o) => p.cp(a, b, o) };
let i = 0;
for (const [f, fn] of Object.entries(forms)) for (const opts of [{ recursive: true }, { recursive: true, dereference: true }, { recursive: true, verbatimSymlinks: true }]) {
  const dst = `${d}/o${i++}`;
  try { await fn(`${d}/src`, dst, opts); console.log(f, JSON.stringify(opts), '->', show(dst)); } catch (e) { console.log(f, JSON.stringify(opts), '-> THROW', h.E(e), '|', show(dst)); }
}
for (const [f, fn] of Object.entries(forms)) for (const opts of [{}, { dereference: true }, { verbatimSymlinks: true }]) {
  const dst = `${d}/f${i++}`;
  try { await fn(`${d}/src/fl`, dst, opts); const st = fs.lstatSync(dst); console.log(f, 'single file link', JSON.stringify(opts), '->', st.isSymbolicLink() ? 'link ' + fs.readlinkSync(dst).replace(cwd, 'CWD') : 'file ' + fs.readFileSync(dst, 'utf8')); } catch (e) { console.log(f, 'single file link', JSON.stringify(opts), '-> THROW', h.E(e)); }
  const dd = `${d}/g${i++}`;
  try { await fn(`${d}/src/dl`, dd, { ...opts, recursive: true }); const st = fs.lstatSync(dd); console.log(f, 'single dir link', JSON.stringify(opts), '->', st.isSymbolicLink() ? 'link ' + fs.readlinkSync(dd).replace(cwd, 'CWD') : 'dir ' + show(dd)); } catch (e) { console.log(f, 'single dir link', JSON.stringify(opts), '-> THROW', h.E(e)); }
}
console.log('outside intact', show(o));
