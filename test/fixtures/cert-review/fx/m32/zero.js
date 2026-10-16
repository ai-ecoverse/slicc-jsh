// kernel-only (the host's Node would read /dev/zero until it runs out of memory)
const fs = require('fs'); const t0 = Date.now();
try { const b = fs.readFileSync('/dev/zero'); console.log('readFileSync /dev/zero returned', b.length); } catch (e) { console.log('readFileSync /dev/zero', e.code, e.message.split('\n')[0], 'in', Math.round((Date.now() - t0) / 1000), 's'); }
try { fs.readFile('/dev/zero', (e, b) => console.log('readFile cb /dev/zero', e ? e.code : b.length)); } catch (e) { console.log('readFile threw', e.code); }
