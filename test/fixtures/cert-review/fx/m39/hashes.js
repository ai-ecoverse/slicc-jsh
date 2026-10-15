const c = require('crypto');
const ALGS = ["RSA-MD5","RSA-RIPEMD160","RSA-SHA1","RSA-SHA1-2","RSA-SHA224","RSA-SHA256","RSA-SHA3-224","RSA-SHA3-256","RSA-SHA3-384","RSA-SHA3-512","RSA-SHA384","RSA-SHA512","RSA-SHA512/224","RSA-SHA512/256","RSA-SM3","blake2b512","blake2s256","id-rsassa-pkcs1-v1_5-with-sha3-224","id-rsassa-pkcs1-v1_5-with-sha3-256","id-rsassa-pkcs1-v1_5-with-sha3-384","id-rsassa-pkcs1-v1_5-with-sha3-512","md5","md5-sha1","md5WithRSAEncryption","ripemd","ripemd160","ripemd160WithRSA","rmd160","sha1","sha1WithRSAEncryption","sha224","sha224WithRSAEncryption","sha256","sha256WithRSAEncryption","sha3-224","sha3-256","sha3-384","sha3-512","sha384","sha384WithRSAEncryption","sha512","sha512-224","sha512-224WithRSAEncryption","sha512-256","sha512-256WithRSAEncryption","sha512WithRSAEncryption","shake128","shake256","sm3","sm3WithRSAEncryption","ssl3-md5","ssl3-sha1"];
const inputs = ['', 'abc', 'a'.repeat(1000), Buffer.from([0, 255, 128, 7]).toString('latin1')];
const big = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a);
const algs = ALGS;
console.log('getHashes', c.getHashes().length, 'missing', ALGS.filter((a) => !c.getHashes().includes(a)).join(','));
for (const a of algs) {
  try {
    const out = inputs.map((s) => c.createHash(a).update(s, 'latin1').digest('hex'));
    const h = c.createHash(a); for (let i = 0; i < big.length; i += 65536) h.update(big.subarray(i, i + 65536));
    let copy = ''; try { const h2 = c.createHash(a).update('ab'); const cp = h2.copy(); h2.update('c'); copy = cp.update('c').digest('hex') === h2.digest('hex') ? 'copy-ok' : 'copy-BAD'; } catch (e) { copy = 'copy ' + e.code; }
    console.log(a, out.join(' '), h.digest('base64'), copy);
  } catch (e) { console.log(a, 'error', e.code, e.message.slice(0, 60)); }
}
for (const [a, len] of [['shake128', 7], ['shake256', 64]]) { try { console.log(a, 'outputLength', len, c.createHash(a, { outputLength: len }).update('x').digest('hex')); } catch (e) { console.log(a, 'error', e.code); } }
try { console.log('crypto.hash', c.hash ? c.hash('sha1', 'abc') : 'none', c.hash ? c.hash('md5', 'abc', 'base64') : ''); } catch (e) { console.log('crypto.hash error', e.code); }
