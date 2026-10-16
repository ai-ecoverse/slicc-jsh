try { const m = require('esmpkg'); console.log('require(esm):', typeof m.default, m.x, m.default && m.default()); } catch (e) { console.log('require(esm) threw', e.code, e.message.slice(0, 80)); }
import('esmpkg').then((m) => console.log('import(esm) from cjs:', m.x, m.default()));
console.log('require(cond):', require('condpkg').kind);
