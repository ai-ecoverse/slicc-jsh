const fs = require('fs'); const path = require('path'); const h = require('./h.cjs');
const d = h.fresh('w-rpl'); const A = path.resolve(d); fs.mkdirSync(`${d}/real/in`, { recursive: true });
fs.symlinkSync('real', `${d}/rel`); fs.symlinkSync(`${A}/real`, `${d}/abs`); fs.symlinkSync('rel', `${d}/chain`); fs.symlinkSync('../chain/in', `${d}/real/deep`); fs.symlinkSync('loopb', `${d}/loopa`); fs.symlinkSync('loopa', `${d}/loopb`); fs.symlinkSync('nowhere', `${d}/dang`);
const c = (s) => String(s).replace(process.cwd(), 'CWD');
const forms = { sync: (q) => fs.realpathSync(q), native: (q) => fs.realpathSync.native(q) };
for (const q of ['rel', 'abs', 'chain', 'chain/in', 'real/deep', 'real/../rel', 'loopa', 'dang', 'nope']) {
  const row = [];
  for (const [n, f] of Object.entries(forms)) { try { row.push(`${n}=${c(f(`${d}/${q}`))}`); } catch (e) { row.push(`${n}=${e.code}:${e.syscall}`); } }
  console.log(q.padEnd(12), row.join(' '));
}
(async () => { for (const q of ['chain/in', 'loopa', 'dang']) { try { console.log('promise', q, c(await fs.promises.realpath(`${d}/${q}`))); } catch (e) { console.log('promise', q, e.code, e.syscall); } await new Promise((r) => fs.realpath(`${d}/${q}`, (e, v) => { console.log('cb', q, e ? e.code : c(v)); r(); })); await new Promise((r) => fs.realpath.native(`${d}/${q}`, (e, v) => { console.log('cb native', q, e ? e.code : c(v)); r(); })); } })();
