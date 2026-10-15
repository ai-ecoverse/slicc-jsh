import { pipeline } from 'node:stream/promises';
import { Readable, Transform, Writable } from 'node:stream';
import fs from 'node:fs';
let out = '';
await pipeline(Readable.from(['a', 'b', 'c']), new Transform({ transform(c, e, cb) { cb(null, String(c).toUpperCase()); } }), new Writable({ write(c, e, cb) { out += c; cb(); } }));
console.log('pipeline', out);
fs.writeFileSync('/tmp/m4s.txt', 'x'.repeat(100000));
await pipeline(fs.createReadStream('/tmp/m4s.txt'), fs.createWriteStream('/tmp/m4s2.txt'));
console.log('fs streams copied', fs.statSync('/tmp/m4s2.txt').size);
