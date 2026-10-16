const fs = require('fs');
const s = fs.statfsSync('/');
console.log(s.constructor.name, Object.keys(s).join(','));
console.log('types', Object.values(s).map((v) => typeof v).join(','));
console.log('sane', s.bsize > 0, s.blocks > 0, s.bfree <= s.blocks, s.bavail <= s.blocks, s.files >= 0);
console.log('bigint', typeof fs.statfsSync('/', { bigint: true }).blocks);
fs.statfs('/', (e, r) => console.log('cb', e, typeof r.bsize));
fs.promises.statfs('/').then((r) => console.log('promise', typeof r.bavail));
try { fs.statfsSync('/nope/x'); } catch (e) { console.log('missing', e.code, e.syscall); }
