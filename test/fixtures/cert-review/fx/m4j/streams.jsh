const { pipeline } = require('node:stream/promises'); const { Readable, Writable } = require('node:stream'); const fs = require('node:fs');
let out = ''; await pipeline(Readable.from(['x', 'y']), new Writable({ write(c, e, cb) { out += c; cb(); } })); console.log('pipeline', out);
fs.writeFileSync('/tmp/j4.txt', 'z'.repeat(50000)); await pipeline(fs.createReadStream('/tmp/j4.txt'), fs.createWriteStream('/tmp/j4b.txt')); console.log('fs copy', fs.statSync('/tmp/j4b.txt').size);
