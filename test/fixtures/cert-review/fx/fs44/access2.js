const fs = require('fs');
console.log(['access', 'accessSync', 'exists', 'existsSync'].map((n) => `${n}:${typeof fs[n]}`).join(' '), 'promises.access', typeof fs.promises.access, 'constants.R_OK', fs.constants?.R_OK);
fs.promises.access('/tmp').then(() => console.log('promises.access ok'), (e) => console.log('promises.access err', e.code));
try { fs.accessSync('/nope'); } catch (e) { console.log('accessSync /nope', e.code); }
