const crypto = require('crypto');
const E = (e) => `${e.code ?? e.name} | ${String(e.message).split('\n')[0]}`;
const t = (l, f) => { try { console.log(l, '->', f()); } catch (e) { console.log(l, '-> THROW', E(e)); } };
const rnd = Buffer.alloc(100003); let s = 3; for (let i = 0; i < rnd.length; i++) { s = (s * 1103515245 + 12345) >>> 0; rnd[i] = s >>> 24; }
const algs = crypto.getHashes(); console.log('getHashes', algs.length, algs.join(','));
const inputs = { empty: '', abc: 'abc', nist448: 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', million_a: 'a'.repeat(1000000), rnd };
const want = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha512-224', 'sha512-256', 'sha3-224', 'sha3-256', 'sha3-384', 'sha3-512', 'shake128', 'shake256', 'ripemd160', 'rmd160', 'blake2b512', 'blake2s256', 'md4', 'sm3', 'RSA-SHA256', 'SHA256', 'whirlpool'];
for (const a of want) for (const [n, v] of Object.entries(inputs)) t(`hash ${a} ${n}`, () => crypto.createHash(a).update(v).digest('hex'));
for (const a of ['sha256', 'sha512', 'sha3-256', 'md5', 'blake2b512']) t(`split ${a}`, () => { const h = crypto.createHash(a); for (let i = 0; i < rnd.length; i += 777) h.update(rnd.subarray(i, i + 777)); return h.digest('hex') === crypto.createHash(a).update(rnd).digest('hex'); });
for (const enc of ['hex', 'base64', 'base64url', 'latin1', 'binary', undefined]) t(`digest enc ${enc}`, () => { const d = crypto.createHash('sha256').update('x').digest(enc); return Buffer.isBuffer(d) ? 'buf:' + d.toString('hex') : d; });
t('update encodings', () => [crypto.createHash('sha1').update('ff00', 'hex').digest('hex'), crypto.createHash('sha1').update('/w==', 'base64').digest('hex'), crypto.createHash('sha1').update('é', 'latin1').digest('hex'), crypto.createHash('sha1').update('é').digest('hex')].join(' '));
t('shake outputLength', () => [crypto.createHash('shake128', { outputLength: 5 }).update('a').digest('hex'), crypto.createHash('shake256', { outputLength: 100 }).update('a').digest('hex')].join(' '));
t('hash copy', () => { const h = crypto.createHash('sha256').update('ab'); const c = h.copy(); c.update('c'); return [h.digest('hex'), c.digest('hex')].join(' '); });
t('digest twice', () => { const h = crypto.createHash('sha256'); h.digest(); return h.digest(); });
t('update after digest', () => { const h = crypto.createHash('sha256'); h.digest(); h.update('x'); });
t('unknown alg', () => crypto.createHash('sha999'));
t('crypto.hash', () => crypto.hash ? [crypto.hash('sha1', 'abc'), crypto.hash('sha256', 'abc', 'base64'), crypto.hash('md5', Buffer.from('abc'), 'buffer').toString('hex')].join(' ') : 'none');
t('hash stream', () => 'below');
const hs = crypto.createHash('sha256'); hs.on('readable', () => { const d = hs.read(); if (d) console.log('hash stream ->', d.toString('hex')); }); hs.write('ab'); hs.end('c');
for (const a of ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha3-256', 'sha512-256', 'ripemd160', 'blake2b512']) {
  t(`hmac rfc4231-1 ${a}`, () => crypto.createHmac(a, Buffer.alloc(20, 0x0b)).update('Hi There').digest('hex'));
  t(`hmac rfc4231-2 ${a}`, () => crypto.createHmac(a, 'Jefe').update('what do ya want for nothing?').digest('hex'));
  t(`hmac long key ${a}`, () => crypto.createHmac(a, Buffer.alloc(131, 0xaa)).update('Test Using Larger Than Block-Size Key - Hash Key First').digest('hex'));
  t(`hmac empty key ${a}`, () => crypto.createHmac(a, '').update(rnd).digest('base64'));
}
t('hmac split', () => { const h = crypto.createHmac('sha256', 'k'); for (let i = 0; i < rnd.length; i += 1000) h.update(rnd.subarray(i, i + 1000)); return h.digest('hex') === crypto.createHmac('sha256', 'k').update(rnd).digest('hex'); });
t('hmac KeyObject', () => crypto.createHmac('sha256', crypto.createSecretKey(Buffer.from('k'))).update('x').digest('hex'));
t('hmac bad alg', () => crypto.createHmac('nope', 'k'));
t('hmac no key', () => crypto.createHmac('sha256'));
t('known sha256 abc', () => crypto.createHash('sha256').update('abc').digest('hex') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
t('known sha3-256 empty', () => crypto.createHash('sha3-256').digest('hex') === 'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a');
t('known sha512 million a', () => crypto.createHash('sha512').update('a'.repeat(1e6)).digest('hex').startsWith('e718483d0ce76964'));
