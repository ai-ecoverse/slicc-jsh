const fs = require('fs'); const { fresh, t, tree } = require('./h.cjs');
const d = fresh('w-loop'); fs.mkdirSync(`${d}/c/s`, { recursive: true }); fs.writeFileSync(`${d}/c/s/f`, 'f'); fs.symlinkSync('..', `${d}/c/s/up`);
t('cpSync recursive tree with a symlink loop', () => fs.cpSync(`${d}/c`, `${d}/out`, { recursive: true }));
let n = 0; const walk = (p, depth) => { if (depth > 6) return; for (const e of fs.readdirSync(p, { withFileTypes: true })) { n++; if (e.isDirectory()) walk(`${p}/${e.name}`, depth + 1); } };
try { walk(`${d}/out`, 0); } catch (e) { console.log('walk', e.code); }
console.log('entries (6 levels)', n, 'up is', fs.lstatSync(`${d}/out/s/up`).isSymbolicLink() ? 'symlink' : 'real dir');
t('realpathSync', () => fs.realpathSync(`${d}/c/s/up`).replace(process.cwd(), 'CWD'));
