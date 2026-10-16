const fs = require('fs'); fs.mkdirSync('/tmp/esmf', { recursive: true });
fs.writeFileSync('/tmp/esmf/m.mjs', 'export const a = 1; export default function f() { return "def"; }\n');
fs.writeFileSync('/tmp/esmf/tla.mjs', 'await Promise.resolve(); export const t = 1;\n');
try { const m = require('/tmp/esmf/m.mjs'); console.log('require(esm)', Object.keys(m).sort().join(','), m.a, typeof m.default, m.default(), m.__esModule, String(m[Symbol.toStringTag])); } catch (e) { console.log('require(esm) threw', e.code, e.message.split('\n')[0]); }
try { require('/tmp/esmf/tla.mjs'); console.log('tla required?!'); } catch (e) { console.log('require(tla)', e.code); }
const f = new Function('return import("/tmp/esmf/m.mjs")');
f().then((m) => console.log('import() in new Function', m.a, m.default())).catch((e) => console.log('import in Function threw', e.code, e.message.split('\n')[0]));
const g = new Function('p', 'return import(p)'); g('node:path').then((m) => console.log('import node: in Function', typeof m.join));
(0, eval)('import("/tmp/esmf/m.mjs")').then((m) => console.log('indirect eval import', m.a)).catch((e) => console.log('eval import threw', e.code));
