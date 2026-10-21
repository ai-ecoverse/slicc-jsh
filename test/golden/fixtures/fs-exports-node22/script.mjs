import * as ns from 'node:fs';
import * as nsBare from 'fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const fsp = require('fs/promises');
const keys = (o) => Object.keys(o).sort().join(',');
console.log('cjs', keys(fs));
console.log('esm', keys(ns));
console.log('esm bare same', keys(ns) === keys(nsBare));
console.log('esm in order', Object.keys(ns).join());
console.log('import() in order', Object.keys(await import('node:fs')).join() === Object.keys(ns).join());
console.log('promises', keys(fs.promises));
console.log('fs/promises same', keys(fsp) === keys(fs.promises));
for (const k of ['F_OK', 'R_OK', 'W_OK', 'X_OK']) {
  const d = Object.getOwnPropertyDescriptor(fs, k);
  console.log(k, fs[k], fs[k] === fs.constants[k], ns[k], d.writable, d.enumerable, d.configurable);
}
console.log('lchmod key', 'lchmod' in fs, 'lchmodSync' in fs, typeof fsp.lchmod);
console.log('FileReadStream', fs.FileReadStream === fs.ReadStream, fs.FileWriteStream === fs.WriteStream, typeof ns.FileReadStream);
const frs = Object.getOwnPropertyDescriptor(fs, 'FileReadStream');
console.log('FileReadStream desc', typeof frs.get, typeof frs.set, frs.enumerable);
console.log('_toUnixTimestamp', fs._toUnixTimestamp(new Date(1500)), fs._toUnixTimestamp('12'), fs._toUnixTimestamp(7));
console.log('promises.constants', fs.promises.constants === fs.constants, fsp.constants === fs.constants);
for (const k of ['glob', 'globSync', 'openAsBlob', 'readv', 'readvSync', 'writev', 'writevSync', 'opendir', 'opendirSync']) {
  console.log(k, typeof fs[k], fs[k].name, fs[k].length, ns[k] === fs[k]);
}
console.log('promises.glob', typeof fs.promises.glob, fs.promises.glob.name, Object.prototype.toString.call(fs.promises.glob));
console.log('Dir', typeof fs.Dir, fs.Dir.name, ns.Dir === fs.Dir, ['path', 'read', 'readSync', 'close', 'closeSync', 'entries'].map((k) => k in fs.Dir.prototype).join(','), typeof fs.Dir.prototype[Symbol.dispose], typeof fs.Dir.prototype[Symbol.asyncDispose]);
const d = fs.opendirSync('.');
console.log('opendirSync is a Dir', d instanceof fs.Dir, d.constructor === fs.Dir, Object.keys(d).length);
d.closeSync();
try {
  Object.getOwnPropertyDescriptor(fs.Dir.prototype, 'path').get.call({});
} catch (e) {
  console.log('Dir path on another this', e.name, e.code, e.message);
}
console.log('Dir asyncIterator', fs.Dir.prototype[Symbol.asyncIterator] === fs.Dir.prototype.entries);
try {
  new fs.Dir();
} catch (e) {
  console.log('new Dir()', e.name, e.code, e.message);
}
