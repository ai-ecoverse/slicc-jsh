const ASN1_REASONS = {
  'nested asn1 error': '0688010A',
  'bad object header': '06800066',
  'header too long': '0680007B',
  'too long': '0680009B',
  'too small': '068000E0',
  'wrong tag': '068000A8',
  'sequence not constructed': '06800095',
  'field missing': '06800079',
  'missing eoc': '06800089',
  'unexpected eoc': '0680009F',
  'type not primitive': '068000C3',
};
const asn1Error = (reason) => `error:${ASN1_REASONS[reason]}:asn1 encoding routines::${reason}`;

export const PKCS8_BAD_DECRYPT = [
  'error:11800074:PKCS12 routines::pkcs12 cipherfinal error',
  'error:1C800064:Provider routines::bad decrypt',
  'error:11800074:PKCS12 routines::pkcs12 cipherfinal error',
];
const PEM_BAD_DECRYPT = ['error:04800065:PEM routines::bad decrypt'];
const PKCS12_DECODE_ERROR = 'error:11800065:PKCS12 routines::decode error';

const OIDS = {
  pbes2: '2a864886f70d01050d',
  pbkdf2: '2a864886f70d01050c',
};
const PRFS = {
  '2a864886f70d0207': 'sha1',
  '2a864886f70d0208': 'sha224',
  '2a864886f70d0209': 'sha256',
  '2a864886f70d020a': 'sha384',
  '2a864886f70d020b': 'sha512',
};
const CIPHERS = {
  '608648016503040102': ['aes-128-cbc', 16],
  '608648016503040116': ['aes-192-cbc', 24],
  '60864801650304012a': ['aes-256-cbc', 32],
};
const TRADITIONAL_CIPHERS = { 'AES-128-CBC': 16, 'AES-192-CBC': 24, 'AES-256-CBC': 32 };

function getObject(b, start, omax) {
  const fail = { error: 'header too long' };
  let p = start;
  let max = omax;
  const cst = (b[p] & 0x20) !== 0;
  const cls = b[p] & 0xc0;
  let tag = b[p] & 0x1f;
  if (tag === 0x1f) {
    p++;
    if (--max === 0) return fail;
    let l = 0;
    while (b[p] & 0x80) {
      l = l * 128 + (b[p++] & 0x7f);
      if (--max === 0) return fail;
      if (l > 0xffffff) return fail;
    }
    l = l * 128 + (b[p++] & 0x7f);
    tag = l;
    if (--max === 0) return fail;
  } else {
    p++;
    if (--max === 0) return fail;
  }
  max--;
  let inf = false;
  let len = 0;
  if (b[p] === 0x80) {
    inf = true;
    p++;
  } else {
    let i = b[p] & 0x7f;
    if (b[p++] & 0x80) {
      if (max < i + 1) return fail;
      while (i > 0 && b[p] === 0) {
        p++;
        i--;
      }
      if (i > 8) return fail;
      let v = 0n;
      for (; i > 0; i--) v = v * 256n + BigInt(b[p++]);
      if (v > 0x7fffffffffffffffn) return fail;
      len = Number(v);
    } else {
      len = i;
    }
  }
  if (inf && !cst) return fail;
  return { p, len, tag, cls, cst, inf, error: len > omax - (p - start) ? 'too long' : null };
}

function checkTlen(b, p, len, tag) {
  const o = getObject(b, p, len);
  if (o.error) return { errors: ['bad object header', o.error] };
  if (o.tag !== tag || o.cls !== 0) return { errors: ['wrong tag'] };
  return { ...o, len: o.inf ? len - (o.p - p) : o.len };
}

function wellFormed(b, start = 0, end = b.length) {
  for (let p = start; p < end; ) {
    const o = getObject(b, p, end - p);
    if (o.error || o.inf || (o.cst && !wellFormed(b, o.p, o.p + o.len))) return false;
    p = o.p + o.len;
  }
  return true;
}

function fieldTags(b, start, end) {
  const tags = [];
  for (let p = start; p < end; ) {
    const o = getObject(b, p, end - p);
    tags.push(b[p]);
    p = o.p + o.len;
  }
  return tags;
}

const SHAPES = {
  'ENCRYPTED PRIVATE KEY': [0x02, 0x30, 0x04],
  'RSA PRIVATE KEY': [0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02],
  'EC PRIVATE KEY': [0x02, 0x04],
};

export function decodeErrors(b, label = 'ENCRYPTED PRIVATE KEY') {
  if (b.length === 0) return ['too small'];
  const seq = checkTlen(b, 0, b.length, 16);
  if (seq.errors) return ['nested asn1 error', ...seq.errors];
  if (!seq.cst) return ['sequence not constructed'];
  const { p, len, inf } = seq;
  if (len === 0) return [inf ? 'missing eoc' : 'field missing'];
  if (len >= 2 && b[p] === 0 && b[p + 1] === 0) return inf ? ['field missing'] : ['unexpected eoc'];
  const version = checkTlen(b, p, len, 2);
  if (version.errors) return ['nested asn1 error', 'nested asn1 error', ...version.errors];
  if (version.cst) return ['nested asn1 error', 'type not primitive'];
  if (inf || p + len !== b.length || !wellFormed(b)) return [];
  const tags = fieldTags(b, p, b.length);
  return SHAPES[label].every((t, i) => tags[i] === t) ? null : [];
}

const REFUSED = Symbol('refused');
const need = (ok) => {
  if (!ok) throw REFUSED;
};

function children(b) {
  const out = [];
  for (let p = 0; p < b.length; ) {
    const o = getObject(b, p, b.length - p);
    need(!o.error && !o.inf);
    out.push({ tag: b[p], body: b.subarray(o.p, o.p + o.len) });
    p = o.p + o.len;
  }
  return out;
}

const hex = (Buffer, field) => Buffer.from(field.body).toString('hex');

function signedInt(field) {
  need(field.tag === 0x02 && field.body.length > 0 && field.body.length <= 8);
  return BigInt.asIntN(field.body.length * 8, field.body.reduce((n, x) => n * 256n + BigInt(x), 0n));
}

function pbes2(Buffer, envelope) {
  const [outer, ...trailing] = children(envelope);
  need(outer?.tag === 0x30 && trailing.length === 0);
  const [alg, data] = children(outer.body);
  need(alg?.tag === 0x30 && data?.tag === 0x04);
  const [oid, params] = children(alg.body);
  need(oid?.tag === 0x06 && hex(Buffer, oid) === OIDS.pbes2 && params?.tag === 0x30);
  const [kdf, scheme] = children(params.body);
  need(kdf?.tag === 0x30 && scheme?.tag === 0x30);
  const [kdfOid, kdfParams] = children(kdf.body);
  need(kdfOid?.tag === 0x06 && hex(Buffer, kdfOid) === OIDS.pbkdf2 && kdfParams?.tag === 0x30);
  const [salt, iterations, ...rest] = children(kdfParams.body);
  need(salt?.tag === 0x04 && iterations !== undefined);
  const count = Number(BigInt.asIntN(32, signedInt(iterations)));
  const keyLength = rest[0]?.tag === 0x02 ? signedInt(rest.shift()) : undefined;
  need(rest.length <= 1);
  let digest = 'sha1';
  if (rest.length) {
    need(rest[0].tag === 0x30);
    const [prfOid] = children(rest[0].body);
    digest = prfOid?.tag === 0x06 ? PRFS[hex(Buffer, prfOid)] : undefined;
  }
  const [cipherOid, iv] = children(scheme.body);
  const cipher = cipherOid?.tag === 0x06 ? CIPHERS[hex(Buffer, cipherOid)] : undefined;
  need(digest && cipher && iv?.tag === 0x04 && iv.body.length === 16);
  need(data.body.length > 0 && data.body.length % 16 === 0);
  const keyLengthError = keyLength !== undefined && keyLength !== BigInt(cipher[1]);
  return { cipher: cipher[0], keyLength: cipher[1], keyLengthError, salt: salt.body, count, digest, iv: iv.body, data: data.body };
}

function unpadded(crypto, Buffer, cipher, key, iv, data) {
  const d = crypto.createDecipheriv(cipher, key, iv);
  d.setAutoPadding(false);
  const plain = Buffer.concat([d.update(data), d.final()]);
  const n = plain[plain.length - 1];
  if (n < 1 || n > 16) return null;
  for (let i = plain.length - n; i < plain.length; i++) if (plain[i] !== n) return null;
  return plain.subarray(0, plain.length - n);
}

function bytesToKey(crypto, Buffer, pass, salt, length) {
  const parts = [];
  let prev = Buffer.alloc(0);
  for (let have = 0; have < length; have += prev.length) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, pass, salt])).digest();
    parts.push(prev);
  }
  return Buffer.concat(parts).subarray(0, length);
}

function pemBlock(text) {
  const m = /-----BEGIN ((?:RSA |EC |ENCRYPTED )?PRIVATE KEY)-----\r?\n([\s\S]*?)-----END \1-----/.exec(text);
  if (!m) return null;
  const [head, body] = /\r?\n\r?\n/.test(m[2]) ? m[2].split(/\r?\n\r?\n/, 2) : ['', m[2]];
  return { label: m[1], headers: head, body: body.replace(/\s+/g, '') };
}

export function lockedKeyError(key, passphrase, crypto, Buffer) {
  const text = typeof key === 'string' ? key : Buffer.from(key.buffer, key.byteOffset, key.byteLength).toString('latin1');
  const block = pemBlock(text);
  if (!block) return null;
  const pass = Buffer.from(passphrase, 'utf8');
  if (block.label === 'ENCRYPTED PRIVATE KEY') {
    let info;
    try {
      info = pbes2(Buffer, Buffer.from(block.body, 'base64'));
    } catch {
      return null;
    }
    if (info.keyLengthError) return { code: 'ERR_OSSL_EVP_UNSUPPORTED_KEYLENGTH' };
    if (info.count < 0) return { code: 'ERR_OSSL_CRYPTO_PARAM_UNSIGNED_INTEGER_NEGATIVE_VALUE_UNSUPPORTED' };
    if (info.count === 0) return { code: 'ERR_OSSL_INVALID_ITERATION_COUNT' };
    const k = crypto.pbkdf2Sync(pass, info.salt, info.count, info.keyLength, info.digest);
    const plain = unpadded(crypto, Buffer, info.cipher, k, info.iv, info.data);
    if (!plain) return { code: 'ERR_OSSL_BAD_DECRYPT', stack: PKCS8_BAD_DECRYPT };
    const errors = decodeErrors(plain);
    if (!errors) return null;
    return { code: 'ERR_OSSL_UNSUPPORTED', stack: errors.length ? [PKCS12_DECODE_ERROR, ...errors.map(asn1Error)] : [] };
  }
  if (!SHAPES[block.label] || !/^Proc-Type:\s*4,ENCRYPTED\s*$/m.test(block.headers)) return null;
  const dek = /^DEK-Info:\s*([A-Za-z0-9-]+),([0-9A-Fa-f]{32})\s*$/m.exec(block.headers);
  const length = dek && TRADITIONAL_CIPHERS[dek[1].toUpperCase()];
  if (!length) return null;
  const data = Buffer.from(block.body, 'base64');
  if (data.length === 0 || data.length % 16) return null;
  const iv = Buffer.from(dek[2], 'hex');
  const k = bytesToKey(crypto, Buffer, pass, iv.subarray(0, 8), length);
  const plain = unpadded(crypto, Buffer, dek[1].toLowerCase(), k, iv, data);
  if (!plain) return { code: 'ERR_OSSL_BAD_DECRYPT', stack: PEM_BAD_DECRYPT };
  const errors = decodeErrors(plain, block.label);
  if (!errors) return null;
  const once = errors.map(asn1Error);
  return { code: 'ERR_OSSL_UNSUPPORTED', stack: [...once, ...once] };
}
