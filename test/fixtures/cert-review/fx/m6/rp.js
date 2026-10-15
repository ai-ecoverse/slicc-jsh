const fs = require('fs'); const { fresh } = require('./h.cjs');
const d = fresh('w-rp'); fs.mkdirSync(`${d}/real/in`, { recursive: true }); fs.symlinkSync('real', `${d}/ln`); fs.symlinkSync('../ln/in', `${d}/real/deep`);
const c = (s) => s.replace(process.cwd(), 'CWD');
for (const p of ['ln', 'ln/in', 'real/deep', 'real/../ln']) { try { console.log(p, c(fs.realpathSync(`${d}/${p}`))); } catch (e) { console.log(p, e.code); } }
require('fs').promises.realpath(`${d}/ln`).then((r) => console.log('promise', c(r)));
fs.realpath(`${d}/ln`, (e, r) => console.log('cb', e && e.code, r && c(r)));
