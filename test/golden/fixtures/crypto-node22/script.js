const crypto = require('crypto');
const { pipeline, Readable, Writable } = require('stream');
const show = (label, f) => {
  let v;
  try {
    v = f();
    if (Buffer.isBuffer(v)) v = `<${v.length}> ${v.toString('hex')}`;
    else if (v instanceof ArrayBuffer) v = `ArrayBuffer ${Buffer.from(v).toString('hex')}`;
    v = v === undefined ? 'undefined' : JSON.stringify(v);
  } catch (e) {
    const extra = e.library ? ` ${e.library}/${e.reason}` : '';
    v = `THROW ${e.name} ${e.code} ${JSON.stringify(e.message)}${extra} | ${String(e.stack).split('\n')[0]}`;
  }
  console.log(`${label}: ${v}`);
};

const algos = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha512-224', 'sha512-256',
  'sha3-224', 'sha3-256', 'sha3-384', 'sha3-512', 'shake128', 'shake256', 'ripemd160', 'blake2b512',
  'blake2s256', 'md5-sha1', 'RSA-SHA256', 'SHA256', 'sha-256', 'rmd160', 'sha256WithRSAEncryption'];
for (const a of algos) show(`createHash ${a}`, () => crypto.createHash(a).update('abc').digest('hex'));
for (const a of ['md5', 'sha1', 'sha256', 'sha512', 'sha3-256', 'ripemd160', 'blake2b512']) {
  show(`createHmac ${a}`, () => crypto.createHmac(a, 'key').update('abc').digest('base64'));
}
show('hash update chunks + encodings', () =>
  crypto.createHash('sha256').update('ab', 'utf8').update('63', 'hex').update(Buffer.from('d')).update(new Uint16Array([1, 2])).digest('base64url'));
show('digest latin1', () => crypto.createHash('md5').update('x').digest('latin1'));
show('digest buffer', () => crypto.createHash('md5').update('x').digest('buffer'));
show('digest unknown encoding', () => crypto.createHash('md5').update('x').digest('nope'));
show('shake256 outputLength 5', () => crypto.createHash('shake256', { outputLength: 5 }).update('a').digest('hex'));
show('shake128 outputLength 0', () => crypto.createHash('shake128', { outputLength: 0 }).digest('hex'));
show('sha256 outputLength 16', () => crypto.createHash('sha256', { outputLength: 16 }));
show('copy', () => {
  const h = crypto.createHash('sha1').update('a');
  const c = h.copy();
  h.update('b');
  return [c.digest('hex'), h.digest('hex')];
});
show('hash digest twice', () => {
  const h = crypto.createHash('sha1');
  h.digest();
  return h.digest();
});
show('hash update after digest', () => {
  const h = crypto.createHash('sha1');
  h.digest();
  return h.update('x');
});
show('hmac digest twice', () => {
  const h = crypto.createHmac('sha1', 'k');
  h.digest();
  return [h.digest('hex'), h.digest().length];
});
show('createHash unknown', () => crypto.createHash('nope'));
show('createHash number', () => crypto.createHash(1));
show('update number', () => crypto.createHash('sha1').update(1));
show('update odd hex', () => crypto.createHash('sha1').update('abc', 'hex'));
show('createHmac unknown', () => crypto.createHmac('nope', 'k'));
show('createHmac key null', () => crypto.createHmac('sha1', null));
show('Hash instances', () => [crypto.createHash('sha1') instanceof crypto.Hash, crypto.Hash.name, crypto.Hash.length]);
show('Hmac instances', () => [crypto.createHmac('sha1', 'k') instanceof crypto.Hmac, crypto.Hmac.name]);
show('hash()', () => [crypto.hash('sha1', 'abc'), crypto.hash('md5', 'abc', 'base64'), crypto.hash('sha256', 'abc', 'buffer').length]);
show('hash() bad encoding', () => crypto.hash('sha1', 'abc', 'nope'));
show('hash() bad algorithm', () => crypto.hash('nope', 'abc'));
show('hash() bad input', () => crypto.hash('sha1', 1));
show('getHashes', () => crypto.getHashes().filter((h) => !/^(RSA-SM3|sm3)/i.test(h)).length);

const key16 = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const key24 = Buffer.alloc(24, 7);
const key32 = Buffer.alloc(32, 9);
const iv16 = Buffer.from('f0e0d0c0b0a090807060504030201000', 'hex');
const plain = 'The quick brown fox jumps over the lazy dog';
const roundTrip = (name, key, iv, opts) => {
  const c = crypto.createCipheriv(name, key, iv, opts);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const d = crypto.createDecipheriv(name, key, iv, opts);
  const dec = Buffer.concat([d.update(enc), d.final()]).toString();
  return [enc.toString('hex'), dec === plain];
};
for (const k of [['128', key16], ['192', key24], ['256', key32]]) {
  for (const mode of ['ecb', 'cbc', 'cfb', 'cfb8', 'cfb1', 'ofb', 'ctr']) {
    const name = `aes-${k[0]}-${mode}`;
    show(name, () => roundTrip(name, k[1], mode === 'ecb' ? null : iv16));
  }
}
show('aes256 alias', () => roundTrip('aes256', key32, iv16));
show('AES-128-CBC upper', () => roundTrip('AES-128-CBC', key16, iv16));
show('des-ede3-cbc', () => roundTrip('des-ede3-cbc', key24, iv16.subarray(0, 8)));
show('des3', () => roundTrip('des3', key24, iv16.subarray(0, 8)));
show('des-ede3 (ecb)', () => roundTrip('des-ede3', key24, null));
show('des-ede-cbc', () => roundTrip('des-ede-cbc', key16, iv16.subarray(0, 8)));
show('update/final encodings', () => {
  const c = crypto.createCipheriv('aes-128-cbc', key16, iv16);
  const enc = c.update(plain, 'utf8', 'base64') + c.final('base64');
  const d = crypto.createDecipheriv('aes-128-cbc', key16, iv16);
  return [enc, d.update(enc, 'base64', 'utf8') + d.final('utf8')];
});
show('string key and iv', () => roundTrip('aes-128-cbc', '0123456789abcdef', 'fedcba9876543210'));
show('KeyObject key', () => roundTrip('aes-128-cbc', crypto.createSecretKey(key16), iv16));
show('no padding, aligned', () => {
  const c = crypto.createCipheriv('aes-128-ecb', key16, null).setAutoPadding(false);
  return Buffer.concat([c.update(Buffer.alloc(32, 1)), c.final()]);
});
show('no padding, partial', () => {
  const c = crypto.createCipheriv('aes-128-cbc', key16, iv16);
  c.setAutoPadding(false);
  c.update(Buffer.alloc(5));
  return c.final();
});
show('decrypt bad padding', () => {
  const d = crypto.createDecipheriv('aes-128-cbc', key16, iv16);
  d.update(Buffer.alloc(16));
  return d.final();
});
show('decrypt partial block', () => {
  const d = crypto.createDecipheriv('aes-128-cbc', key16, iv16);
  d.update(Buffer.alloc(5));
  return d.final();
});
show('decrypt empty', () => crypto.createDecipheriv('aes-128-cbc', key16, iv16).final());
show('decrypt empty no padding', () => crypto.createDecipheriv('aes-128-cbc', key16, iv16).setAutoPadding(false).final());
show('final twice', () => {
  const c = crypto.createCipheriv('aes-128-cbc', key16, iv16);
  c.final();
  return c.final();
});
show('update after final', () => {
  const c = crypto.createCipheriv('aes-128-cbc', key16, iv16);
  c.final();
  return c.update('x');
});
show('setAutoPadding after final', () => {
  const c = crypto.createCipheriv('aes-128-cbc', key16, iv16);
  c.final();
  return c.setAutoPadding(false);
});
show('unknown cipher', () => crypto.createCipheriv('nope', key16, iv16));
show('legacy cipher', () => crypto.createCipheriv('des-cbc', Buffer.alloc(8), Buffer.alloc(8)));
show('bad key length', () => crypto.createCipheriv('aes-128-cbc', Buffer.alloc(15), iv16));
show('bad iv length', () => crypto.createCipheriv('aes-128-cbc', key16, Buffer.alloc(15)));
show('null iv for cbc', () => crypto.createCipheriv('aes-128-cbc', key16, null));
show('iv for ecb', () => crypto.createCipheriv('aes-128-ecb', key16, iv16));
show('cipher name number', () => crypto.createCipheriv(1, key16, iv16));
show('key number', () => crypto.createCipheriv('aes-128-cbc', 1, iv16));
show('iv number', () => crypto.createCipheriv('aes-128-cbc', key16, 1));
show('change output encoding', () => {
  const c = crypto.createCipheriv('aes-128-cbc', key16, iv16);
  c.update('x', 'utf8', 'hex');
  return c.final('base64');
});
show('unknown output encoding', () => crypto.createCipheriv('aes-128-cbc', key16, iv16).update('x', 'utf8', 'nope'));

const iv12 = Buffer.alloc(12, 3);
const gcm = (name, key, iv, opts, tagLen) => {
  const c = crypto.createCipheriv(name, key, iv, opts);
  c.setAAD(Buffer.from('header'));
  const enc = Buffer.concat([c.update(plain), c.final()]);
  const tag = c.getAuthTag();
  const d = crypto.createDecipheriv(name, key, iv, opts);
  d.setAAD(Buffer.from('header'));
  d.setAuthTag(tagLen ? tag.subarray(0, tagLen) : tag);
  return [enc.toString('hex'), tag.toString('hex'), Buffer.concat([d.update(enc), d.final()]).toString() === plain];
};
show('aes-128-gcm', () => gcm('aes-128-gcm', key16, iv12));
show('aes-192-gcm', () => gcm('aes-192-gcm', key24, iv12));
show('aes-256-gcm iv16', () => gcm('aes-256-gcm', key32, iv16));
show('id-aes128-GCM', () => gcm('id-aes128-GCM', key16, iv12));
show('gcm authTagLength 8', () => gcm('aes-128-gcm', key16, iv12, { authTagLength: 8 }));
show('gcm decipher short tag', () => gcm('aes-128-gcm', key16, iv12, undefined, 12));
show('gcm bad tag', () => {
  const d = crypto.createDecipheriv('aes-128-gcm', key16, iv12);
  d.setAuthTag(Buffer.alloc(16));
  d.update(Buffer.from('aa', 'hex'));
  return d.final();
});
show('gcm no tag', () => {
  const d = crypto.createDecipheriv('aes-128-gcm', key16, iv12);
  d.update(Buffer.from('aa', 'hex'));
  return d.final();
});
show('gcm bad tag length', () => crypto.createDecipheriv('aes-128-gcm', key16, iv12).setAuthTag(Buffer.alloc(3)));
show('gcm bad authTagLength', () => crypto.createCipheriv('aes-128-gcm', key16, iv12, { authTagLength: 3 }));
show('gcm tag/authTagLength mismatch', () =>
  crypto.createDecipheriv('aes-128-gcm', key16, iv12, { authTagLength: 16 }).setAuthTag(Buffer.alloc(8)));
show('gcm setAuthTag twice', () => {
  const d = crypto.createDecipheriv('aes-128-gcm', key16, iv12);
  d.setAuthTag(Buffer.alloc(16));
  return d.setAuthTag(Buffer.alloc(16));
});
show('gcm setAAD after update', () => {
  const c = crypto.createCipheriv('aes-128-gcm', key16, iv12);
  c.update('x');
  return c.setAAD(Buffer.alloc(1));
});
show('gcm getAuthTag before final', () => crypto.createCipheriv('aes-128-gcm', key16, iv12).getAuthTag());
show('cbc setAAD', () => crypto.createCipheriv('aes-128-cbc', key16, iv16).setAAD(Buffer.alloc(1)));
show('cbc getAuthTag', () => {
  const c = crypto.createCipheriv('aes-128-cbc', key16, iv16);
  c.final();
  return c.getAuthTag();
});
show('gcm empty iv', () => crypto.createCipheriv('aes-128-gcm', key16, Buffer.alloc(0)));
show('decipher has no getAuthTag', () => typeof crypto.createDecipheriv('aes-128-gcm', key16, iv12).getAuthTag);
show('cipher has no setAuthTag', () => typeof crypto.createCipheriv('aes-128-gcm', key16, iv12).setAuthTag);
show('getCiphers', () => {
  const ours = crypto.getCiphers();
  return ['aes-128-cbc', 'aes-256-gcm', 'aes128', 'des-ede3-cbc', 'des3', 'id-aes128-GCM'].map((c) => ours.includes(c));
});
show('getCipherInfo', () => [
  crypto.getCipherInfo('aes128'),
  crypto.getCipherInfo('AES-128-GCM', { ivLength: 16 }),
  crypto.getCipherInfo('aes-128-cbc', { ivLength: 12 }),
  crypto.getCipherInfo('aes-128-cbc', { keyLength: 12 }),
  crypto.getCipherInfo('nope'),
  crypto.getCipherInfo(895),
  crypto.getCipherInfo('des-ede3'),
]);

show('pbkdf2Sync sha1', () => crypto.pbkdf2Sync('password', 'salt', 2, 20, 'sha1'));
show('pbkdf2Sync sha512', () => crypto.pbkdf2Sync('password', 'salt', 1000, 64, 'sha512'));
show('pbkdf2Sync sha3-256', () => crypto.pbkdf2Sync('a', 'b', 2, 8, 'sha3-256'));
show('pbkdf2Sync keylen 0', () => crypto.pbkdf2Sync('a', 'b', 1, 0, 'sha256'));
show('pbkdf2Sync iterations 0', () => crypto.pbkdf2Sync('a', 'b', 0, 1, 'sha1'));
show('pbkdf2Sync digest unknown', () => crypto.pbkdf2Sync('a', 'b', 1, 1, 'nope'));
show('pbkdf2Sync digest missing', () => crypto.pbkdf2Sync('a', 'b', 1, 1));
show('pbkdf2Sync password number', () => crypto.pbkdf2Sync(1, 'b', 1, 1, 'sha1'));
show('pbkdf2 no callback', () => crypto.pbkdf2('a', 'b', 1, 1, 'sha1'));
show('hkdfSync', () => crypto.hkdfSync('sha256', 'key', 'salt', 'info', 42));
show('hkdfSync empty salt', () => crypto.hkdfSync('sha512', Buffer.from('k'), '', '', 16));
show('hkdfSync KeyObject', () => crypto.hkdfSync('sha256', crypto.createSecretKey('key'), 'salt', 'info', 8));
show('hkdfSync length 0', () => crypto.hkdfSync('sha256', 'a', 'b', 'c', 0));
show('scryptSync keylen 0', () => crypto.scryptSync('a', 'b', 0));
show('hkdfSync too long', () => crypto.hkdfSync('sha256', 'a', 'b', 'c', 255 * 32 + 1));
show('hkdfSync info > 1024', () => crypto.hkdfSync('sha256', 'a', 'b', Buffer.alloc(1025), 4));
show('hkdfSync digest unknown', () => crypto.hkdfSync('nope', 'a', 'b', 'c', 4));
show('hkdfSync ikm number', () => crypto.hkdfSync('sha256', 1, 'b', 'c', 4));
show('hkdf digest unknown (sync throw)', () => crypto.hkdf('nope', 'a', 'b', 'c', 4, () => {}));
show('scryptSync', () => crypto.scryptSync('password', 'salt', 16));
show('scryptSync N=1024 r=4 p=2', () => crypto.scryptSync('pw', 'salt', 32, { N: 1024, r: 4, p: 2 }));
show('scryptSync cost/blockSize/parallelization', () =>
  crypto.scryptSync('pw', 'salt', 8, { cost: 256, blockSize: 2, parallelization: 1 }));
show('scryptSync N not power of 2', () => crypto.scryptSync('a', 'b', 16, { N: 3 }));
show('scryptSync memory', () => crypto.scryptSync('a', 'b', 16, { N: 2 ** 20 }));
show('scryptSync N and cost', () => crypto.scryptSync('a', 'b', 16, { N: 16, cost: 16 }));
show('scryptSync keylen -1', () => crypto.scryptSync('a', 'b', -1));

show('createSecretKey', () => {
  const k = crypto.createSecretKey(Buffer.from('abc'));
  return [k.type, k.symmetricKeySize, k.export().toString(), k.export({ format: 'jwk' }), k.equals(crypto.createSecretKey('abc')),
    k instanceof crypto.KeyObject, Object.prototype.toString.call(k), k.constructor.name, k.asymmetricKeyType];
});
show('createSecretKey number', () => crypto.createSecretKey(1));
show('createSecretKey encoding', () => crypto.createSecretKey('616263', 'hex').export().toString());
show('new KeyObject', () => new crypto.KeyObject('secret', {}));
show('new KeyObject bad type', () => new crypto.KeyObject('nope', {}));
show('generateKeySync hmac', () => crypto.generateKeySync('hmac', { length: 123 }).symmetricKeySize);
show('generateKeySync aes', () => crypto.generateKeySync('aes', { length: 256 }).symmetricKeySize);
show('generateKeySync aes 100', () => crypto.generateKeySync('aes', { length: 100 }));
show('generateKeySync unknown', () => crypto.generateKeySync('nope', { length: 100 }));
show('hmac with KeyObject', () => crypto.createHmac('sha256', crypto.createSecretKey('key')).update('abc').digest('hex'));

show('randomBytes', () => [crypto.randomBytes(0).length, crypto.randomBytes(70000).length]);
show('randomBytes string', () => crypto.randomBytes('x'));
show('randomBytes -1', () => crypto.randomBytes(-1));
show('randomBytes bad callback', () => crypto.randomBytes(1, 'x'));
show('randomFillSync', () => {
  const b = Buffer.alloc(8);
  crypto.randomFillSync(b, 4);
  return b.subarray(0, 4).toString('hex');
});
show('randomFillSync Uint32Array offset', () => {
  const a = new Uint32Array(4);
  crypto.randomFillSync(a, 3, 1);
  return [a[0], a[1], a[2]];
});
show('randomFillSync ArrayBuffer', () => crypto.randomFillSync(new ArrayBuffer(4)).byteLength);
show('randomFillSync offset too big', () => crypto.randomFillSync(Buffer.alloc(4), 5));
show('randomFillSync size too big', () => crypto.randomFillSync(Buffer.alloc(4), 1, 4));
show('randomFillSync string', () => crypto.randomFillSync('x'));
show('randomInt range', () => {
  for (let i = 0; i < 200; i++) {
    const n = crypto.randomInt(3, 7);
    if (n < 3 || n >= 7 || !Number.isInteger(n)) return n;
  }
  return 'ok';
});
show('randomInt 1.5', () => crypto.randomInt(1.5));
show('randomInt max <= min', () => crypto.randomInt(5, 1));
show('randomInt range too big', () => crypto.randomInt(0, 2 ** 48 + 1));
show('randomUUID', () => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID()));
show('randomUUID bad option', () => crypto.randomUUID({ disableEntropyCache: 1 }));
show('getRandomValues', () => crypto.getRandomValues(new Uint8Array(4)).length);
show('timingSafeEqual', () => [
  crypto.timingSafeEqual(Buffer.from('abc'), Buffer.from('abc')),
  crypto.timingSafeEqual(Buffer.from('abc'), Buffer.from('abd')),
  crypto.timingSafeEqual(new Uint8Array([1, 2]), new Uint16Array([0x201]).buffer),
]);
show('timingSafeEqual lengths', () => crypto.timingSafeEqual(Buffer.alloc(1), Buffer.alloc(2)));
show('timingSafeEqual string', () => crypto.timingSafeEqual('a', Buffer.alloc(1)));
show('constants', () => [crypto.constants.RSA_PKCS1_PADDING, crypto.constants.POINT_CONVERSION_COMPRESSED, typeof crypto.constants.defaultCipherList]);
show('webcrypto', () => [crypto.webcrypto === globalThis.crypto, crypto.subtle === globalThis.crypto.subtle]);
show('getFips', () => crypto.getFips());
show('secureHeapUsed', () => crypto.secureHeapUsed());
show('setEngine', () => crypto.setEngine('x'));
show('exports', () => ['Certificate', 'Cipher', 'Cipheriv', 'Decipheriv', 'Hash', 'Hmac', 'KeyObject', 'createSign',
  'generateKeyPairSync', 'scryptSync', 'hkdfSync', 'subtle', 'webcrypto'].map((k) => typeof crypto[k]));
show('require node:crypto', () => require('node:crypto') === crypto);

(async () => {
  const cb = (fn) => new Promise((resolve) => fn((err, v) => resolve(err ? `ERR ${err.code} ${err.message}` : v)));
  const hexOf = (v) => (Buffer.isBuffer(v) ? v.toString('hex') : v instanceof ArrayBuffer ? Buffer.from(v).toString('hex') : v);
  console.log('pbkdf2', hexOf(await cb((done) => crypto.pbkdf2('pw', 'salt', 1000, 16, 'sha512', done))));
  console.log('pbkdf2 keylen 0', hexOf(await cb((done) => crypto.pbkdf2('pw', 'salt', 1, 0, 'sha1', done))));
  console.log('hkdf', hexOf(await cb((done) => crypto.hkdf('sha256', 'key', 'salt', 'info', 16, done))));
  console.log('scrypt', hexOf(await cb((done) => crypto.scrypt('pw', 'salt', 16, { N: 256 }, done))));
  console.log('scrypt default options', hexOf(await cb((done) => crypto.scrypt('pw', 'salt', 8, done))));
  console.log('randomBytes cb', (await cb((done) => crypto.randomBytes(12, done))).length);
  console.log('randomFill cb', (await cb((done) => crypto.randomFill(Buffer.alloc(6), 2, done))).length);
  console.log('randomInt cb', typeof (await cb((done) => crypto.randomInt(10, done))));
  console.log('generateKey', (await cb((done) => crypto.generateKey('hmac', { length: 64 }, done))).symmetricKeySize);
  let order = [];
  crypto.randomBytes(1, () => order.push('randomBytes'));
  process.nextTick(() => order.push('nextTick'));
  await new Promise((r) => setTimeout(r, 20));
  console.log('callback order', order);
  // Streams: Hash and Cipher are Transforms.
  const chunks = [];
  await new Promise((resolve, reject) =>
    pipeline(
      Readable.from([Buffer.from('stream '), Buffer.from('me')]),
      crypto.createHash('sha256'),
      new Writable({
        write(c, e, cb2) {
          chunks.push(c);
          cb2();
        },
      }),
      (err) => (err ? reject(err) : resolve())
    )
  );
  console.log('hash stream', Buffer.concat(chunks).toString('hex'));
  const h = crypto.createHash('sha1');
  h.end('abc');
  console.log('hash read', h.read().toString('hex'), h.digest('hex'));
  const enc = [];
  await new Promise((resolve, reject) => {
    const c = crypto.createCipheriv('aes-128-ctr', key16, iv16);
    c.on('data', (d) => enc.push(d));
    c.on('end', resolve);
    c.on('error', reject);
    c.write('stream ');
    c.end('cipher');
  });
  console.log('cipher stream', Buffer.concat(enc).toString('hex'));
  await new Promise((resolve) => {
    const d = crypto.createDecipheriv('aes-128-cbc', key16, iv16);
    d.on('error', (e) => {
      console.log('decipher stream error', e.code, e.message);
      resolve();
    });
    d.on('data', () => {});
    d.end(Buffer.alloc(16));
  });
  const unavailable = ['createSign', 'createECDH', 'generateKeyPairSync', 'publicEncrypt', 'createPrivateKey'];
  for (const name of unavailable) {
    try {
      crypto[name]('x');
    } catch (e) {
      console.log(`${name}: thrown`);
    }
  }
})();
