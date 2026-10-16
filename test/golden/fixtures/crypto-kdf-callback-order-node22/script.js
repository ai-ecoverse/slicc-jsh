// Node 22 runs pbkdf2 / hkdf / scrypt on the thread pool and calls back in
// the order they finish. Each job here is done before the next is submitted
// (the synchronous work between them takes far longer than the job), so Node's
// order is the order of the calls (ai-ecoverse/slicc-jsh#279; the cert
// review's m12/kdf.js).
const crypto = require('crypto');
const busy = () => crypto.pbkdf2Sync('pw', 'salt', 100000, 32, 'sha256');
const log = (name) => (err, key) => console.log(name, err ? err.code : 'ok', Buffer.from(key).toString('hex').slice(0, 16));
crypto.pbkdf2('pw', 'salt', 1000, 32, 'sha256', log('pbkdf2'));
busy();
crypto.hkdf('sha256', 'key', 'salt', 'info', 16, log('hkdf'));
busy();
crypto.scrypt('pw', 'salt', 16, { N: 1024 }, log('scrypt'));
busy();
crypto.hkdf('sha512', 'key', 'salt', 'info', 16, log('hkdf 2'));
console.log('script done');
