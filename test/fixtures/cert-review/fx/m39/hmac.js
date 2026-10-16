const c = require('crypto');
const ALGS = ["RSA-MD5","RSA-RIPEMD160","RSA-SHA1","RSA-SHA1-2","RSA-SHA224","RSA-SHA256","RSA-SHA3-224","RSA-SHA3-256","RSA-SHA3-384","RSA-SHA3-512","RSA-SHA384","RSA-SHA512","RSA-SHA512/224","RSA-SHA512/256","RSA-SM3","blake2b512","blake2s256","id-rsassa-pkcs1-v1_5-with-sha3-224","id-rsassa-pkcs1-v1_5-with-sha3-256","id-rsassa-pkcs1-v1_5-with-sha3-384","id-rsassa-pkcs1-v1_5-with-sha3-512","md5","md5-sha1","md5WithRSAEncryption","ripemd","ripemd160","ripemd160WithRSA","rmd160","sha1","sha1WithRSAEncryption","sha224","sha224WithRSAEncryption","sha256","sha256WithRSAEncryption","sha3-224","sha3-256","sha3-384","sha3-512","sha384","sha384WithRSAEncryption","sha512","sha512-224","sha512-224WithRSAEncryption","sha512-256","sha512-256WithRSAEncryption","sha512WithRSAEncryption","shake128","shake256","sm3","sm3WithRSAEncryption","ssl3-md5","ssl3-sha1"];
const keys = ['', 'key', 'k'.repeat(200), Buffer.from('0b'.repeat(20), 'hex')];
for (const a of ALGS) {
  try { console.log('hmac', a, keys.map((k) => c.createHmac(a, k).update('The quick brown fox').digest('hex')).join(' ')); } catch (e) { console.log('hmac', a, 'error', e.code); }
}
const run = (l, f) => { try { console.log(l, f()); } catch (e) { console.log(l, 'error', e.code, e.message.slice(0, 50)); } };
for (const d of ['sha1', 'sha256', 'sha512', 'sha3-256', 'md5', 'ripemd160']) run('pbkdf2 ' + d, () => c.pbkdf2Sync('password', 'salt', 1000, 37, d).toString('hex'));
run('pbkdf2 empty', () => c.pbkdf2Sync('', '', 1, 20, 'sha256').toString('hex'));
run('scrypt default', () => c.scryptSync('pw', 'salt', 64).toString('hex'));
run('scrypt N=1024 r=8 p=2', () => c.scryptSync('pw', 'NaCl', 32, { N: 1024, r: 8, p: 2 }).toString('base64'));
run('scrypt bad N', () => c.scryptSync('pw', 's', 16, { N: 3 }).toString('hex'));
for (const d of ['sha256', 'sha512', 'sha1', 'sha384']) run('hkdf ' + d, () => Buffer.from(c.hkdfSync(d, 'ikm', 'salt', 'info', 42)).toString('hex'));
run('hkdf too long', () => c.hkdfSync('sha256', 'k', 's', 'i', 255 * 32 + 1));
run('randomBytes', () => { const b = c.randomBytes(33); return [Buffer.isBuffer(b), b.length, c.randomBytes(0).length].join(','); });
run('randomUUID', () => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c.randomUUID()));
run('randomInt', () => { const v = c.randomInt(5, 10); return v >= 5 && v < 10; });
run('randomFillSync', () => c.randomFillSync(new Uint32Array(4)).length);
run('getRandomValues', () => c.getRandomValues(new Uint8Array(8)).length);
run('timingSafeEqual', () => [c.timingSafeEqual(Buffer.from('ab'), Buffer.from('ab')), c.timingSafeEqual(Buffer.from('ab'), Buffer.from('ac'))].join(','));
c.pbkdf2('p', 's', 10, 16, 'sha256', (e, k) => console.log('pbkdf2 async', e && e.code, k && k.toString('hex')));
c.scrypt('p', 's', 16, (e, k) => console.log('scrypt async', e && e.code, k && k.toString('hex')));
c.hkdf('sha256', 'k', 's', 'i', 16, (e, k) => console.log('hkdf async', e && e.code, k && Buffer.from(k).toString('hex')));
c.randomBytes(5, (e, b) => console.log('randomBytes async', e, b.length));
(async () => { const d = await c.subtle.digest('SHA-256', new TextEncoder().encode('abc')); console.log('subtle sha256', Buffer.from(d).toString('hex')); })();
