const crypto = require('crypto');
for (const h of ['sm3', 'md4', 'mdc2', 'whirlpool', 'md5', 'nope']) { try { crypto.createHash(h); console.log('hash', h, 'ok'); } catch (e) { console.log('hash', h, e.code, e.message); } }
console.log('getHashes has sm3', crypto.getHashes().includes('sm3'), 'md4', crypto.getHashes().includes('md4'));
try { crypto.pbkdf2('p', 's', 1, 32, 'nope', (err) => console.log('pbkdf2 bad digest cb', err && err.code)); } catch (e) { console.log('pbkdf2 bad digest threw sync', e.code); }
crypto.pbkdf2('p', 's', 1, 32, 'sha256', (err, k) => console.log('pbkdf2 cb', err, k.length));
try { crypto.scrypt('p', 's', 64, { N: 3 }, (err) => console.log('scrypt bad N cb', err && err.code)); } catch (e) { console.log('scrypt bad N threw sync', e.code); }
try { crypto.scrypt('p', 's', 16, { N: 1 << 25, r: 8 }, (err) => console.log('scrypt memory cb', err && err.code)); } catch (e) { console.log('scrypt memory threw sync', e.code); }
try { crypto.hkdf('nope', 'k', 's', 'i', 16, (err) => console.log('hkdf bad digest cb', err && err.code)); } catch (e) { console.log('hkdf bad digest threw sync', e.code); }
try { crypto.generateKeyPair('rsa', { modulusLength: 512 }, (err, pub) => console.log('generateKeyPair cb', err ? 'err' : 'ok ' + typeof pub)); } catch (e) { console.log('generateKeyPair threw', e.code); }
crypto.randomBytes(8, (err, b) => console.log('randomBytes cb', err, b.length));
crypto.randomFill(Buffer.alloc(4), (err, b) => console.log('randomFill cb', err, b.length));
