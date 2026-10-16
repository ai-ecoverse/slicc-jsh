const c = require('constants'); const fs = require('fs');
try { const e = (() => { try { fs.createReadStream('/x', 'bogus'); } catch (e) { return e; } })(); console.log('rs bogus err', e && e.name, e && e.message.slice(0, 80)); } catch {}
console.log(Object.keys(c).sort().join(' '));
