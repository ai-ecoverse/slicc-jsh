// #91: legacy zlib.Z_* constants and bytesWritten, golden vs Node 22
const zlib = require('zlib');
const legacy = Object.getOwnPropertyNames(zlib).filter((n) => /^Z_/.test(n)).sort();
console.log('count', legacy.length);
console.log('names', legacy.join(','));
console.log('values', legacy.map((n) => zlib[n]).join(','));
const d = Object.getOwnPropertyDescriptor(zlib, 'Z_NO_FLUSH');
console.log('descriptor', JSON.stringify(d));
console.log('enumerable keys with Z_', Object.keys(zlib).filter((n) => /^Z_/.test(n)).length);
try { 'use strict'; zlib.Z_NO_FLUSH = 99; } catch (e) { console.log('assign threw', e.name); }
console.log('after assign', zlib.Z_NO_FLUSH);
(() => { 'use strict'; try { zlib.Z_NO_FLUSH = 99; console.log('strict assign ok'); } catch (e) { console.log('strict assign', e.name); } })();
console.log('constants match', legacy.every((n) => zlib.constants[n] === zlib[n]));
console.log('codes', JSON.stringify(zlib.codes));
const big = Buffer.alloc(200000, 'abcdefghij');
const g = zlib.createGzip();
let out = 0;
g.on('data', (c) => (out += c.length));
g.on('end', () => console.log('gzip bytesWritten', g.bytesWritten, 'in', big.length, 'out>0', out > 0));
g.write(big.subarray(0, 70000)); console.log('bytesWritten after write (sync)', g.bytesWritten);
g.end(big.subarray(70000));
const inf = zlib.createInflate();
const def = zlib.deflateSync(big);
inf.on('data', () => {}); inf.on('end', () => console.log('inflate bytesWritten', inf.bytesWritten, 'deflated', def.length, inf.bytesWritten === def.length));
inf.end(def);
const dz = zlib.createDeflateRaw(); dz.on('data', () => {}); dz.on('finish', () => console.log('deflateRaw bytesWritten at finish', dz.bytesWritten)); dz.end('hello world');
