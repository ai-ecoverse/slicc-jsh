const e = await import('sliccy:exec');
console.log(typeof e.default, typeof e.exec, typeof (e.default && e.default.spawn), Object.keys(e).join(','), Object.prototype.toString.call(e));
const c = await import('sliccy:cli');
console.log(typeof c.default.die, typeof c.die, c.default === require('sliccy:cli'), Object.keys(c).join(','));
const again = await import('sliccy:cli');
console.log('same ns', again === c);
try { await import('sliccy:nope'); } catch (err) { console.log('nope', err.message.split('.')[0]); }
const p = await import('node:path');
console.log('path', typeof p.join);
const viaRequire = require('sliccy:exec');
console.log('same value', (await import('sliccy:exec')).default === viaRequire);
const fmt = await import('sliccy:fmt');
console.log('fmt names', Object.keys(fmt).length > 1, 'default' in fmt);
