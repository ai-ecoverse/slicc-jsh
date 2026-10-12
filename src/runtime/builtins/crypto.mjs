/**
 * crypto: Node 22's JS layer (lib/internal/crypto/{hash,cipher,keys,pbkdf2,
 * hkdf,scrypt,random}.js and lib/internal/streams/lazy_transform.js, ported)
 * over a small binding to pure-JS primitives, bundled lazily as
 * dist/vendor/crypto.cjs: @noble/hashes (digests, HMAC, PBKDF2, HKDF, scrypt)
 * and browserify-aes / browserify-des (block ciphers). Random numbers,
 * `webcrypto` and `subtle` are the platform's WebCrypto.
 *
 * Here: Hash / createHash / hash, Hmac / createHmac, getHashes, Cipheriv /
 * Decipheriv (AES ECB/CBC/CFB/CFB8/CFB1/OFB/CTR/GCM, 3DES), getCiphers,
 * getCipherInfo, pbkdf2(Sync), hkdf(Sync), scrypt(Sync), the random* family,
 * randomUUID, getRandomValues, timingSafeEqual, KeyObject / createSecretKey /
 * generateKey(Sync) for secret keys, webcrypto, subtle, constants.
 *
 * Not here (no pure-JS implementation at a reasonable size): asymmetric keys,
 * sign/verify, DH/ECDH, RSA encryption, primes, X509, and the ciphers OpenSSL
 * has beyond those above (CCM, OCB, XTS, ChaCha20, wrap, ARIA, Camellia, SM4).
 * They throw ERR_FEATURE_UNAVAILABLE_ON_PLATFORM.
 */
import { loadVendorCjs } from '../vendor-load.mjs';
import { deprecate } from './util.mjs';
import { trackPromise } from '../async-handles.mjs';
import {
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_ARG_VALUE,
  ERR_OUT_OF_RANGE,
  nativeError,
  nodeError,
  normalizeEncoding,
  validateBoolean,
  validateEncoding,
  validateFunction,
  validateInt32,
  validateInteger,
  validateNumber,
  validateObject,
  validateString,
  validateUint32,
} from '../node-errors.mjs';
import { CIPHER_INFO, CRYPTO_CONSTANTS, NODE_CIPHERS, NODE_HASHES } from './crypto-constants.mjs';

const PACKAGE_ROOT = '/node_modules/@ai-ecoverse/slicc-jsh';
const kMaxLength = 2 ** 53 - 1;
const kHandle = Symbol('kHandle');
const kState = Symbol('kState');
const kFinalized = Symbol('kFinalized');
const kKeyObject = Symbol('kKeyObject');

const isArrayBufferView = (v) => ArrayBuffer.isView(v);
const isAnyArrayBuffer = (v) => {
  const tag = Object.prototype.toString.call(v);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
};

const ERR_CRYPTO_INVALID_STATE = (op) =>
  nodeError(Error, 'ERR_CRYPTO_INVALID_STATE', `Invalid state for operation ${op}`);
const ERR_CRYPTO_HASH_FINALIZED = () => nodeError(Error, 'ERR_CRYPTO_HASH_FINALIZED', 'Digest already called');
const invalidDigest = (name) => nativeError(TypeError, 'ERR_CRYPTO_INVALID_DIGEST', `Invalid digest: ${name}`);
const opensslError = (code, hex, library, reason) =>
  nativeError(Error, code, `error:${hex}:${library}::${reason}`, { library, reason });

function unavailable(what) {
  return nativeError(
    Error,
    'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
    `${what} is not available in slicc-jsh (no pure-JS implementation); use crypto.subtle where it applies`
  );
}

// --- digest names: OpenSSL 3's, case-insensitive, with its aliases ----------

const DIGEST_ALIASES = (() => {
  const a = Object.create(null);
  const add = (canon, ...names) => {
    for (const n of [canon, ...names]) a[n.toLowerCase()] = canon;
  };
  add('md5', 'rsa-md5', 'md5withrsaencryption', 'ssl3-md5');
  add('sha1', 'sha-1', 'rsa-sha1', 'sha1withrsaencryption', 'ssl3-sha1', 'rsa-sha1-2');
  for (const n of ['224', '256', '384', '512']) {
    add(`sha${n}`, `sha-${n}`, `sha2-${n}`, `rsa-sha${n}`, `sha${n}withrsaencryption`);
    add(`sha3-${n}`, `rsa-sha3-${n}`, `id-rsassa-pkcs1-v1_5-with-sha3-${n}`);
  }
  for (const n of ['224', '256']) {
    add(`sha512-${n}`, `sha512/${n}`, `sha-512/${n}`, `sha2-512/${n}`, `rsa-sha512/${n}`, `sha512-${n}withrsaencryption`);
  }
  add('ripemd160', 'ripemd', 'rmd160', 'ripemd-160', 'rsa-ripemd160', 'ripemd160withrsa');
  add('shake128', 'shake-128');
  add('shake256', 'shake-256');
  add('blake2b512');
  add('blake2s256');
  add('md5-sha1');
  add('sm3', 'rsa-sm3', 'sm3withrsaencryption');
  return a;
})();

const digestOf = (name) => (typeof name === 'string' ? DIGEST_ALIASES[name.toLowerCase()] : undefined);

// Digests in OpenSSL 3's legacy provider, which Node 22 doesn't load: known
// names that fail "unsupported" rather than "Digest method not supported".
const LEGACY_DIGEST = new Set([
  'md4', 'rsa-md4', 'md4withrsaencryption',
  'mdc2', 'rsa-mdc2', 'mdc2withrsa',
  'whirlpool',
]);
const isLegacyDigest = (name) => typeof name === 'string' && LEGACY_DIGEST.has(name.toLowerCase());
const INIT_ERROR = 'error:03000086:digital envelope routines::initialization error';
const UNSUPPORTED = 'error:0308010C:digital envelope routines::unsupported';
/** Node 22's error for one (its key order; a Hash's stack has both lines). */
function evpUnsupported(forHash) {
  const err = new Error(UNSUPPORTED);
  err.opensslErrorStack = forHash ? [INIT_ERROR, UNSUPPORTED] : [INIT_ERROR];
  err.library = 'digital envelope routines';
  err.reason = 'unsupported';
  err.code = 'ERR_OSSL_EVP_UNSUPPORTED';
  return err;
}

// --- ciphers -----------------------------------------------------------------

const CIPHER_LC = Object.create(null);
for (const [name, info] of Object.entries(CIPHER_INFO)) CIPHER_LC[name.toLowerCase()] = info;

// Node's names for our implementations (browserify-aes suites, browserify-des modes).
const CIPHER_IMPL = (() => {
  const m = Object.create(null);
  for (const k of ['128', '192', '256']) {
    for (const mode of ['ecb', 'cbc', 'cfb', 'cfb8', 'cfb1', 'ofb', 'ctr', 'gcm']) {
      m[`aes-${k}-${mode}`] = { aes: `aes-${k}-${mode}` };
    }
    m[`aes${k}`] = { aes: `aes-${k}-cbc` };
    m[`id-aes${k}-gcm`] = { aes: `aes-${k}-gcm` };
  }
  m['des-ede3-cbc'] = { des: 'des-ede3-cbc' };
  m.des3 = { des: 'des-ede3-cbc' };
  m['des-ede3'] = { des: 'des-ede3' };
  m['des-ede3-ecb'] = { des: 'des-ede3' };
  m['des-ede-cbc'] = { des: 'des-ede-cbc' };
  m['des-ede'] = { des: 'des-ede' };
  m['des-ede-ecb'] = { des: 'des-ede' };
  return m;
})();

// In OpenSSL 3's legacy provider (not loaded by Node 22): "unsupported".
const LEGACY_CIPHER = /^(des(-cbc|-ecb|-cfb|-cfb1|-cfb8|-ofb)?|desx(-cbc)?|bf(-cbc|-ecb|-cfb|-ofb)?|blowfish|cast5?(-cbc|-ecb|-cfb|-ofb)?|rc2(-.*)?|rc4(-.*)?|idea(-.*)?|seed(-.*)?)$/;

const NODE_CIPHERS_LC = new Set(NODE_CIPHERS.map((n) => n.toLowerCase()));

const GCM_TAG_LENGTHS = new Set([4, 8, 12, 13, 14, 15, 16]);

export function createCrypto({ ctx, process, Buffer, getStream, stringDecoder, handles, timers }) {
  const lib = loadVendorCjs({
    ctx,
    packageRoot: PACKAGE_ROOT,
    name: 'crypto',
    globals: { process, Buffer },
    process,
    requires: {
      stream: getStream(),
      'readable-stream': getStream(),
      string_decoder: stringDecoder,
    },
  });
  const web = globalThis.crypto;
  const { StringDecoder } = stringDecoder;
  const setImmediate = (fn, ...args) => timers.setImmediate(fn, ...args);
  const track = (p) => (handles ? trackPromise(handles, p) : p);
  // A job's callback runs from the loop, so its throw is an uncaught exception.
  const settle = (promise, callback, map = (x) => x) => {
    track(promise).then(
      (value) => setImmediate(() => callback(null, map(value))),
      (err) => setImmediate(() => callback(err))
    );
  };

  const toU8 = (data, encoding) => {
    if (typeof data === 'string') return Buffer.from(data, normalizeEncoding(encoding) ?? 'utf8');
    if (isAnyArrayBuffer(data)) return new Uint8Array(data);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  };
  const toBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  const encodeOutput = (buf, encoding) => {
    const enc = encoding && encoding !== 'buffer' ? normalizeEncoding(encoding) : undefined;
    return enc ? buf.toString(enc) : buf;
  };

  // Buffer.from(string, encoding) as the JS layer calls it: an unknown
  // encoding throws (only the native update() paths fall back to UTF-8).
  const bufferFromString = (str, encoding) => {
    const enc = normalizeEncoding(encoding);
    if (enc === undefined) throw nodeError(TypeError, 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${encoding}`);
    return Buffer.from(str, enc);
  };

  // lib/internal/crypto/util.js
  function getArrayBufferOrView(buffer, name, encoding) {
    if (isAnyArrayBuffer(buffer)) return buffer;
    if (typeof buffer === 'string') {
      if (encoding === 'buffer') encoding = 'utf8';
      return bufferFromString(buffer, encoding);
    }
    if (!isArrayBufferView(buffer)) {
      throw ERR_INVALID_ARG_TYPE(name, ['string', 'ArrayBuffer', 'Buffer', 'TypedArray', 'DataView'], buffer);
    }
    return buffer;
  }
  const toBuf = (val, encoding) => {
    if (typeof val === 'string') {
      if (encoding === 'buffer') encoding = 'utf8';
      return bufferFromString(val, encoding);
    }
    return val;
  };
  function validateByteSource(val, name) {
    val = toBuf(val);
    if (isAnyArrayBuffer(val) || isArrayBufferView(val)) return val;
    throw ERR_INVALID_ARG_TYPE(name, ['string', 'ArrayBuffer', 'TypedArray', 'DataView', 'Buffer'], val);
  }
  const getStringOption = (options, key) => {
    let value;
    if (options && (value = options[key]) != null) validateString(value, `options.${key}`);
    return value;
  };

  // --- lazy_transform.js ---
  const { Transform } = getStream();
  function LazyTransform(options) {
    this._options = options;
  }
  Object.setPrototypeOf(LazyTransform.prototype, Transform.prototype);
  Object.setPrototypeOf(LazyTransform, Transform);
  const makeGetter = (name) =>
    function () {
      Transform.call(this, this._options);
      this._writableState.decodeStrings = false;
      return this[name];
    };
  const makeSetter = (name) =>
    function (val) {
      Object.defineProperty(this, name, { value: val, enumerable: true, configurable: true, writable: true });
    };
  for (const name of ['_readableState', '_writableState']) {
    Object.defineProperty(LazyTransform.prototype, name, {
      get: makeGetter(name),
      set: makeSetter(name),
      configurable: true,
      enumerable: true,
    });
  }

  // --- keys.js: secret keys -------------------------------------------------
  const kKeyBytes = Symbol('kKeyBytes');
  class SecretKeyHandle {
    constructor(bytes) {
      this[kKeyBytes] = bytes;
    }
  }
  class KeyObject {
    constructor(type, handle) {
      if (type !== 'secret' && type !== 'public' && type !== 'private') {
        throw ERR_INVALID_ARG_VALUE('type', type);
      }
      if (typeof handle !== 'object' || !(handle instanceof SecretKeyHandle)) {
        throw ERR_INVALID_ARG_TYPE('handle', 'object', handle);
      }
      this[kKeyObject] = type;
      Object.defineProperty(this, kHandle, { value: handle, enumerable: false, configurable: false, writable: false });
    }
    get type() {
      return this[kKeyObject];
    }
    static from(key) {
      void key;
      throw unavailable('KeyObject.from');
    }
    equals(otherKeyObject) {
      if (!(otherKeyObject instanceof KeyObject)) {
        throw ERR_INVALID_ARG_TYPE('otherKeyObject', 'KeyObject', otherKeyObject);
      }
      if (otherKeyObject.type !== this.type) return false;
      const a = this[kHandle][kKeyBytes];
      const b = otherKeyObject[kHandle][kKeyBytes];
      return a.length === b.length && a.every((x, i) => x === b[i]);
    }
    get [Symbol.toStringTag]() {
      return 'KeyObject';
    }
  }
  class SecretKeyObject extends KeyObject {
    constructor(handle) {
      super('secret', handle);
    }
    get symmetricKeySize() {
      return this[kHandle][kKeyBytes].length;
    }
    get asymmetricKeyType() {
      return undefined;
    }
    export(options) {
      if (options !== undefined) {
        validateObject(options, 'options');
        validateOneOf(options.format, 'options.format', [undefined, 'buffer', 'jwk']);
        if (options.format === 'jwk') {
          return { kty: 'oct', k: Buffer.from(this[kHandle][kKeyBytes]).toString('base64url') };
        }
      }
      return Buffer.from(this[kHandle][kKeyBytes]);
    }
  }
  function validateOneOf(value, name, oneOf) {
    if (!oneOf.includes(value)) {
      const allowed = oneOf.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(', ');
      throw ERR_INVALID_ARG_VALUE(name, value, `must be one of: ${allowed}`);
    }
  }
  const isCryptoKey = (key) => typeof CryptoKey !== 'undefined' && key instanceof CryptoKey;
  function getKeyTypes(allowKeyObject, bufferOnly = false) {
    const types = ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView', 'string'];
    if (bufferOnly) return types.slice(0, 4);
    if (allowKeyObject) types.push('KeyObject', 'CryptoKey');
    return types;
  }
  function prepareSecretKey(key, encoding, bufferOnly = false) {
    if (!bufferOnly) {
      if (key instanceof KeyObject) {
        if (key.type !== 'secret') {
          throw nodeError(TypeError, 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', `Invalid key object type ${key.type}, expected secret.`);
        }
        return key[kHandle][kKeyBytes];
      }
      if (isCryptoKey(key)) throw unavailable('A CryptoKey as a node:crypto key');
    }
    if (typeof key !== 'string' && !isArrayBufferView(key) && !isAnyArrayBuffer(key)) {
      throw ERR_INVALID_ARG_TYPE('key', getKeyTypes(!bufferOnly, bufferOnly), key);
    }
    return toU8(getArrayBufferOrView(key, 'key', encoding));
  }
  function createSecretKey(key, encoding) {
    const bytes = prepareSecretKey(key, encoding, true);
    return new SecretKeyObject(new SecretKeyHandle(Uint8Array.from(bytes)));
  }
  function generateKeySync(type, options) {
    validateString(type, 'type');
    validateObject(options, 'options');
    const { length } = options;
    switch (type) {
      case 'hmac':
        validateInteger(length, 'options.length', 8, 2 ** 31 - 1);
        break;
      case 'aes':
        validateOneOf(length, 'options.length', [128, 192, 256]);
        break;
      default:
        throw ERR_INVALID_ARG_VALUE('type', type, 'must be a supported key type');
    }
    return createSecretKey(randomBytes(Math.floor(length / 8)));
  }
  function generateKey(type, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    validateFunction(callback, 'callback');
    const key = generateKeySync(type, options);
    setImmediate(() => callback(null, key));
  }

  // --- hash.js ---
  class HashHandle {
    constructor(algorithm, xofLen) {
      if (algorithm instanceof HashHandle) {
        this.canon = algorithm.canon;
        this.h = algorithm.h.clone();
      } else {
        const canon = digestOf(algorithm);
        if (!canon && isLegacyDigest(algorithm)) throw evpUnsupported(true);
        if (!canon) throw nativeError(Error, undefined, 'Digest method not supported');
        this.canon = canon;
        this.h = canon === 'md5-sha1' ? md5sha1() : lib.hashes[canon].create();
      }
      if (this.canon === 'shake128' || this.canon === 'shake256') {
        this.xofLen = xofLen ?? (this.canon === 'shake128' ? 16 : 32);
      } else if (xofLen !== undefined && xofLen !== this.h.outputLen) {
        throw opensslError(
          'ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH',
          '030000B2',
          'digital envelope routines',
          'not XOF or invalid length'
        );
      }
    }
    update(data, encoding) {
      this.h.update(toU8(data, encoding));
      return true;
    }
    // Node's handle keeps its digest: digest() after the stream's flush
    // returns it again.
    digest(outputEncoding) {
      if (!this.md) {
        if (this.xofLen === undefined) this.md = this.h.digest();
        else this.md = this.xofLen === 0 ? new Uint8Array(0) : this.h.xof(this.xofLen);
      }
      return encodeOutput(Buffer.from(this.md), outputEncoding);
    }
  }
  function md5sha1() {
    const a = lib.hashes.md5.create();
    const b = lib.hashes.sha1.create();
    const pair = (x, y) => ({
      update(d) {
        x.update(d);
        y.update(d);
        return this;
      },
      digest() {
        const p = x.digest();
        const q = y.digest();
        const out = new Uint8Array(p.length + q.length);
        out.set(p);
        out.set(q, p.length);
        return out;
      },
      outputLen: 36,
      clone: () => pair(x.clone(), y.clone()),
    });
    return pair(a, b);
  }

  function Hash(algorithm, options) {
    if (!new.target) return new Hash(algorithm, options);
    const isCopy = algorithm instanceof HashHandle;
    if (!isCopy) validateString(algorithm, 'algorithm');
    const xofLen = typeof options === 'object' && options !== null ? options.outputLength : undefined;
    if (xofLen !== undefined) validateUint32(xofLen, 'options.outputLength');
    this[kHandle] = new HashHandle(algorithm, xofLen);
    this[kState] = { [kFinalized]: false };
    LazyTransform.call(this, options);
  }
  Object.setPrototypeOf(Hash.prototype, LazyTransform.prototype);
  Object.setPrototypeOf(Hash, LazyTransform);
  Hash.prototype.copy = function copy(options) {
    if (this[kState][kFinalized]) throw ERR_CRYPTO_HASH_FINALIZED();
    return new Hash(this[kHandle], options);
  };
  Hash.prototype._transform = function _transform(chunk, encoding, callback) {
    this[kHandle].update(chunk, encoding);
    callback();
  };
  Hash.prototype._flush = function _flush(callback) {
    this.push(this[kHandle].digest());
    callback();
  };
  Hash.prototype.update = function update(data, encoding) {
    if (this[kState][kFinalized]) throw ERR_CRYPTO_HASH_FINALIZED();
    if (typeof data === 'string') validateEncoding(data, encoding);
    else if (!isArrayBufferView(data)) {
      throw ERR_INVALID_ARG_TYPE('data', ['string', 'Buffer', 'TypedArray', 'DataView'], data);
    }
    if (!this[kHandle].update(data, encoding)) {
      throw nodeError(Error, 'ERR_CRYPTO_HASH_UPDATE_FAILED', 'Hash update failed');
    }
    return this;
  };
  Hash.prototype.digest = function digest(outputEncoding) {
    if (this[kState][kFinalized]) throw ERR_CRYPTO_HASH_FINALIZED();
    const ret = this[kHandle].digest(outputEncoding && `${outputEncoding}`);
    this[kState][kFinalized] = true;
    return ret;
  };

  class HmacHandle {
    init(hmac, key) {
      const canon = digestOf(hmac);
      if (!canon && isLegacyDigest(hmac)) throw evpUnsupported(false);
      if (!canon || canon === 'md5-sha1' || canon.startsWith('shake')) throw invalidDigest(hmac);
      this.h = lib.hmac.create(lib.hashes[canon], key);
    }
    update(data, encoding) {
      this.h.update(toU8(data, encoding));
      return true;
    }
    digest(outputEncoding) {
      return encodeOutput(toBuffer(this.h.digest()), outputEncoding);
    }
  }
  function Hmac(hmac, key, options) {
    if (!(this instanceof Hmac)) return new Hmac(hmac, key, options);
    validateString(hmac, 'hmac');
    const encoding = getStringOption(options, 'encoding');
    key = prepareSecretKey(key, encoding);
    this[kHandle] = new HmacHandle();
    this[kHandle].init(hmac, key);
    this[kState] = { [kFinalized]: false };
    LazyTransform.call(this, options);
  }
  Object.setPrototypeOf(Hmac.prototype, LazyTransform.prototype);
  Object.setPrototypeOf(Hmac, LazyTransform);
  Hmac.prototype.update = Hash.prototype.update;
  Hmac.prototype.digest = function digest(outputEncoding) {
    if (this[kState][kFinalized]) {
      const buf = Buffer.from('');
      if (outputEncoding && outputEncoding !== 'buffer') return buf.toString(outputEncoding);
      return buf;
    }
    const ret = this[kHandle].digest(outputEncoding && `${outputEncoding}`);
    this[kState][kFinalized] = true;
    return ret;
  };
  Hmac.prototype._flush = Hash.prototype._flush;
  Hmac.prototype._transform = Hash.prototype._transform;

  function hash(algorithm, input, outputEncoding = 'hex') {
    validateString(algorithm, 'algorithm');
    if (typeof input !== 'string' && !isArrayBufferView(input)) {
      throw ERR_INVALID_ARG_TYPE('input', ['Buffer', 'TypedArray', 'DataView', 'string'], input);
    }
    let normalized = outputEncoding;
    if (outputEncoding !== 'hex') {
      validateString(outputEncoding, 'outputEncoding');
      normalized = normalizeEncoding(outputEncoding);
      if (normalized === undefined) {
        if (outputEncoding.toLowerCase() === 'buffer') normalized = 'buffer';
        else throw ERR_INVALID_ARG_VALUE('outputEncoding', outputEncoding);
      }
    }
    if (!digestOf(algorithm) && isLegacyDigest(algorithm)) throw evpUnsupported(true);
    if (!digestOf(algorithm)) throw nativeError(Error, undefined, `Digest method ${algorithm} is not supported`);
    return new Hash(algorithm).update(input).digest(normalized);
  }

  // --- cipher.js ---
  class CipherBase {
    constructor(decipher) {
      this.decrypt = !decipher;
    }
    initiv(cipher, key, iv, authTagLength) {
      const lc = cipher.toLowerCase();
      const impl = CIPHER_IMPL[lc];
      if (!impl) {
        if (LEGACY_CIPHER.test(lc)) {
          throw opensslError('ERR_OSSL_EVP_UNSUPPORTED', '0308010C', 'digital envelope routines', 'unsupported');
        }
        if (NODE_CIPHERS_LC.has(lc)) throw unavailable(`The ${cipher} cipher`);
        throw nativeError(Error, 'ERR_CRYPTO_UNKNOWN_CIPHER', 'Unknown cipher');
      }
      const info = CIPHER_LC[lc];
      this.info = info;
      this.gcm = info.mode === 'gcm';
      this.blockSize = info.blockSize;
      const ivBytes = iv === null ? new Uint8Array(0) : toU8(iv);
      const expectedIv = info.ivLength ?? 0;
      if (this.gcm ? ivBytes.length === 0 : ivBytes.length !== expectedIv) {
        throw nativeError(TypeError, 'ERR_CRYPTO_INVALID_IV', 'Invalid initialization vector');
      }
      if (key.length !== info.keyLength) {
        throw nativeError(RangeError, 'ERR_CRYPTO_INVALID_KEYLEN', 'Invalid key length');
      }
      if (this.gcm) {
        if (authTagLength !== -1 && !GCM_TAG_LENGTHS.has(authTagLength)) {
          throw nativeError(TypeError, 'ERR_CRYPTO_INVALID_AUTH_TAG', `Invalid authentication tag length: ${authTagLength}`);
        }
        this.authTagLength = authTagLength === -1 ? 16 : authTagLength;
        this.authTagGiven = authTagLength !== -1;
      }
      const k = toBuffer(key);
      const v = toBuffer(ivBytes);
      if (impl.aes) {
        this.c = this.decrypt ? lib.aes.createDecipheriv(impl.aes, k, v) : lib.aes.createCipheriv(impl.aes, k, v);
      } else {
        this.c = new lib.DES({ key: k, iv: v.length ? v : Buffer.alloc(8), mode: impl.des, decrypt: this.decrypt });
      }
      this.state = 'init';
      this.padding = true;
      this.inBytes = 0;
      this.authTag = undefined;
      this.tagSet = false;
    }
    update(data, encoding) {
      if (this.state !== 'init') {
        throw nativeError(Error, undefined, 'Trying to add data in unsupported state');
      }
      const bytes = toBuffer(toU8(data, encoding));
      this.inBytes += bytes.length;
      this.updated = true;
      return this.c.update(bytes);
    }
    final() {
      if (this.state !== 'init') throw nativeError(Error, 'ERR_CRYPTO_INVALID_STATE', 'Invalid state');
      this.state = 'done';
      if (this.blockSize > 1) {
        const partial = this.inBytes % this.blockSize !== 0;
        if (partial || (this.decrypt && this.padding && this.inBytes === 0)) {
          if (this.decrypt || !this.padding) {
            throw opensslError('ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH', '1C80006B', 'Provider routines', 'wrong final block length');
          }
        }
        if (!this.padding && this.inBytes === 0) return Buffer.alloc(0);
      }
      try {
        const out = this.c.final();
        if (this.gcm && !this.decrypt) this.authTag = this.c.getAuthTag().subarray(0, this.authTagLength);
        return out ?? Buffer.alloc(0);
      } catch (err) {
        if (this.gcm) throw nativeError(Error, undefined, 'Unsupported state or unable to authenticate data');
        if (this.decrypt) throw opensslError('ERR_OSSL_BAD_DECRYPT', '1C800064', 'Provider routines', 'bad decrypt');
        throw err;
      }
    }
    setAutoPadding(ap) {
      if (this.state !== 'init') return false;
      this.padding = ap;
      if (this.c._des) this.c._des.padding = ap;
      else this.c.setAutoPadding(ap);
      return true;
    }
    getAuthTag() {
      if (!this.gcm || this.decrypt || this.state !== 'done') return undefined;
      return Buffer.from(this.authTag);
    }
    setAuthTag(tag) {
      if (!this.gcm || !this.decrypt || this.state !== 'init' || this.tagSet) return false;
      const t = toU8(tag);
      if (!GCM_TAG_LENGTHS.has(t.length) || (this.authTagGiven && t.length !== this.authTagLength)) {
        throw nativeError(TypeError, 'ERR_CRYPTO_INVALID_AUTH_TAG', `Invalid authentication tag length: ${t.length}`);
      }
      this.tagSet = true;
      this.c.setAuthTag(toBuffer(Uint8Array.from(t)));
      return true;
    }
    setAAD(aad) {
      if (!this.gcm || this.state !== 'init' || this.updated) return false;
      this.c.setAAD(toBuffer(toU8(aad)));
      return true;
    }
  }

  function getDecoder(decoder, encoding) {
    const normalizedEncoding = normalizeEncoding(encoding);
    decoder ||= new StringDecoder(encoding);
    if (decoder.encoding !== normalizedEncoding) {
      if (normalizedEncoding === undefined) {
        throw nodeError(TypeError, 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${encoding}`);
      }
      throw nodeError(
        Error,
        'ERR_INTERNAL_ASSERTION',
        'Cannot change encoding\nThis is caused by either a bug in Node.js or incorrect usage of Node.js internals.\n' +
          'Please open an issue with this stack trace at https://github.com/nodejs/node/issues\n'
      );
    }
    return decoder;
  }
  function getUIntOption(options, key) {
    let value;
    if (options && (value = options[key]) != null) {
      if (value >>> 0 !== value) throw ERR_INVALID_ARG_VALUE(`options.${key}`, value);
      return value;
    }
    return -1;
  }
  function createCipherWithIV(cipher, key, options, decipher, iv) {
    validateString(cipher, 'cipher');
    const encoding = getStringOption(options, 'encoding');
    key = prepareSecretKey(key, encoding);
    iv = iv === null ? null : getArrayBufferOrView(iv, 'iv');
    const authTagLength = getUIntOption(options, 'authTagLength');
    this[kHandle] = new CipherBase(decipher);
    this[kHandle].initiv(cipher, key, iv, authTagLength);
    this._decoder = null;
    LazyTransform.call(this, options);
  }

  function Cipher(cipher, password, options) {
    if (!(this instanceof Cipher)) return new Cipher(cipher, password, options);
  }
  Object.setPrototypeOf(Cipher.prototype, LazyTransform.prototype);
  Object.setPrototypeOf(Cipher, LazyTransform);
  Cipher.prototype._transform = function _transform(chunk, encoding, callback) {
    this.push(this[kHandle].update(chunk, encoding));
    callback();
  };
  Cipher.prototype._flush = function _flush(callback) {
    try {
      this.push(this[kHandle].final());
    } catch (e) {
      callback(e);
      return;
    }
    callback();
  };
  Cipher.prototype.update = function update(data, inputEncoding, outputEncoding) {
    if (typeof data === 'string') validateEncoding(data, inputEncoding);
    else if (!isArrayBufferView(data)) {
      throw ERR_INVALID_ARG_TYPE('data', ['string', 'Buffer', 'TypedArray', 'DataView'], data);
    }
    const ret = this[kHandle].update(data, inputEncoding);
    if (outputEncoding && outputEncoding !== 'buffer') {
      this._decoder = getDecoder(this._decoder, outputEncoding);
      return this._decoder.write(ret);
    }
    return ret;
  };
  Cipher.prototype.final = function final(outputEncoding) {
    const ret = this[kHandle].final();
    if (outputEncoding && outputEncoding !== 'buffer') {
      this._decoder = getDecoder(this._decoder, outputEncoding);
      return this._decoder.end(ret);
    }
    return ret;
  };
  Cipher.prototype.setAutoPadding = function setAutoPadding(ap) {
    if (!this[kHandle].setAutoPadding(!!ap)) throw ERR_CRYPTO_INVALID_STATE('setAutoPadding');
    return this;
  };
  Cipher.prototype.getAuthTag = function getAuthTag() {
    const ret = this[kHandle].getAuthTag();
    if (ret === undefined) throw ERR_CRYPTO_INVALID_STATE('getAuthTag');
    return ret;
  };
  function setAuthTag(tagbuf, encoding) {
    tagbuf = getArrayBufferOrView(tagbuf, 'buffer', encoding);
    if (!this[kHandle].setAuthTag(tagbuf)) throw ERR_CRYPTO_INVALID_STATE('setAuthTag');
    return this;
  }
  Cipher.prototype.setAAD = function setAAD(aadbuf, options) {
    const encoding = getStringOption(options, 'encoding');
    getUIntOption(options, 'plaintextLength');
    aadbuf = getArrayBufferOrView(aadbuf, 'aadbuf', encoding);
    if (!this[kHandle].setAAD(aadbuf)) throw ERR_CRYPTO_INVALID_STATE('setAAD');
    return this;
  };

  function Cipheriv(cipher, key, iv, options) {
    if (!(this instanceof Cipheriv)) return new Cipheriv(cipher, key, iv, options);
    createCipherWithIV.call(this, cipher, key, options, true, iv);
  }
  function addCipherPrototypeFunctions(constructor) {
    constructor.prototype._transform = Cipher.prototype._transform;
    constructor.prototype._flush = Cipher.prototype._flush;
    constructor.prototype.update = Cipher.prototype.update;
    constructor.prototype.final = Cipher.prototype.final;
    constructor.prototype.setAutoPadding = Cipher.prototype.setAutoPadding;
    if (constructor === Cipheriv) constructor.prototype.getAuthTag = Cipher.prototype.getAuthTag;
    else constructor.prototype.setAuthTag = setAuthTag;
    constructor.prototype.setAAD = Cipher.prototype.setAAD;
  }
  Object.setPrototypeOf(Cipheriv.prototype, LazyTransform.prototype);
  Object.setPrototypeOf(Cipheriv, LazyTransform);
  addCipherPrototypeFunctions(Cipheriv);

  function Decipher(cipher, password, options) {
    if (!(this instanceof Decipher)) return new Decipher(cipher, password, options);
  }
  Object.setPrototypeOf(Decipher.prototype, LazyTransform.prototype);
  Object.setPrototypeOf(Decipher, LazyTransform);
  addCipherPrototypeFunctions(Decipher);

  function Decipheriv(cipher, key, iv, options) {
    if (!(this instanceof Decipheriv)) return new Decipheriv(cipher, key, iv, options);
    createCipherWithIV.call(this, cipher, key, options, false, iv);
  }
  Object.setPrototypeOf(Decipheriv.prototype, LazyTransform.prototype);
  Object.setPrototypeOf(Decipheriv, LazyTransform);
  addCipherPrototypeFunctions(Decipheriv);

  function getCipherInfo(nameOrNid, options) {
    if (typeof nameOrNid !== 'string' && typeof nameOrNid !== 'number') {
      throw ERR_INVALID_ARG_TYPE('nameOrNid', ['string', 'number'], nameOrNid);
    }
    if (typeof nameOrNid === 'number') validateInt32(nameOrNid, 'nameOrNid');
    let keyLength;
    let ivLength;
    if (options !== undefined) {
      validateObject(options, 'options');
      ({ keyLength, ivLength } = options);
      if (keyLength !== undefined) validateInt32(keyLength, 'options.keyLength');
      if (ivLength !== undefined) validateInt32(ivLength, 'options.ivLength');
    }
    const info =
      typeof nameOrNid === 'number'
        ? Object.values(CIPHER_INFO).find((i) => i.nid === nameOrNid)
        : CIPHER_LC[nameOrNid.toLowerCase()];
    if (!info) return undefined;
    if (keyLength !== undefined && keyLength !== info.keyLength) return undefined;
    const ret = { ...info };
    if (ivLength !== undefined) {
      if (info.mode === 'gcm') {
        if (ivLength < 1) return undefined;
        ret.ivLength = ivLength;
      } else if (ivLength !== (info.ivLength ?? 0)) return undefined;
    }
    return ret;
  }

  const getCiphers = () => NODE_CIPHERS.filter((n) => CIPHER_IMPL[n.toLowerCase()]);
  const getHashes = () => NODE_HASHES.filter((n) => digestOf(n));

  // --- pbkdf2.js ---
  function pbkdf2Check(password, salt, iterations, keylen, digest) {
    validateString(digest, 'digest');
    password = getArrayBufferOrView(password, 'password');
    salt = getArrayBufferOrView(salt, 'salt');
    validateInt32(iterations, 'iterations', 1);
    validateInt32(keylen, 'keylen', 0);
    const canon = digestOf(digest);
    // A legacy-provider digest is known, so the job starts and then fails.
    if (!canon && isLegacyDigest(digest)) return { failed: true };
    if (!canon || canon === 'md5-sha1' || canon.startsWith('shake')) throw invalidDigest(digest);
    return { password: toU8(password), salt: toU8(salt), iterations, keylen, fn: lib.hashes[canon] };
  }
  // Node 22.22's PBKDF2Job fails a zero-length key ("Deriving bits failed").
  const derivingBitsFailed = () => nativeError(Error, undefined, 'Deriving bits failed');
  function pbkdf2Sync(password, salt, iterations, keylen, digest) {
    const o = pbkdf2Check(password, salt, iterations, keylen, digest);
    if (o.failed || o.keylen === 0) throw derivingBitsFailed();
    return toBuffer(lib.pbkdf2(o.fn, o.password, o.salt, { c: o.iterations, dkLen: o.keylen }));
  }
  function pbkdf2(password, salt, iterations, keylen, digest, callback) {
    if (typeof digest === 'function') {
      callback = digest;
      digest = undefined;
    }
    const o = pbkdf2Check(password, salt, iterations, keylen, digest);
    validateFunction(callback, 'callback');
    const job =
      o.failed || o.keylen === 0
        ? Promise.reject(derivingBitsFailed())
        : lib.pbkdf2Async(o.fn, o.password, o.salt, { c: o.iterations, dkLen: o.keylen });
    settle(job, callback, (u8) => Buffer.from(u8));
  }

  // --- hkdf.js ---
  function hkdfPrepareKey(key) {
    if (key instanceof KeyObject) return key;
    if (isAnyArrayBuffer(key)) return createSecretKey(key);
    key = toBuf(key);
    if (!isArrayBufferView(key)) {
      throw ERR_INVALID_ARG_TYPE('ikm', ['string', 'SecretKeyObject', 'ArrayBuffer', 'TypedArray', 'DataView', 'Buffer'], key);
    }
    return createSecretKey(key);
  }
  // validateParameters, then HKDFJob's constructor checks (digest, length):
  // all synchronous, for hkdf() too.
  function hkdfValidate(digest, key, salt, info, length) {
    validateString(digest, 'digest');
    key = hkdfPrepareKey(key);
    salt = validateByteSource(salt, 'salt');
    info = validateByteSource(info, 'info');
    validateInteger(length, 'length', 0, kMaxLength);
    if (info.byteLength > 1024) {
      throw ERR_OUT_OF_RANGE('info', 'must not contain more than 1024 bytes', info.byteLength);
    }
    const canon = digestOf(digest);
    if (!canon && isLegacyDigest(digest)) return { failed: true };
    if (!canon || canon === 'md5-sha1' || canon.startsWith('shake')) throw invalidDigest(digest);
    const fn = lib.hashes[canon];
    if (length > 255 * fn.outputLen) throw nativeError(RangeError, 'ERR_CRYPTO_INVALID_KEYLEN', 'Invalid key length');
    return { fn, key, salt, info, length };
  }
  function hkdfRun({ failed, fn, key, salt, info, length }) {
    // As pbkdf2: Node 22.22's HKDFJob fails a zero length.
    if (failed || length === 0) throw derivingBitsFailed();
    const out = new ArrayBuffer(length);
    new Uint8Array(out).set(lib.hkdf(fn, prepareSecretKey(key), toU8(salt), toU8(info), length));
    return out;
  }
  function hkdfSync(digest, key, salt, info, length) {
    return hkdfRun(hkdfValidate(digest, key, salt, info, length));
  }
  function hkdf(digest, key, salt, info, length, callback) {
    const params = hkdfValidate(digest, key, salt, info, length);
    validateFunction(callback, 'callback');
    let result;
    try {
      result = hkdfRun(params);
    } catch (err) {
      setImmediate(() => callback(err));
      return;
    }
    setImmediate(() => callback(null, result));
  }

  // --- scrypt.js ---
  const scryptDefaults = { N: 16384, r: 8, p: 1, maxmem: 32 << 20 };
  function scryptCheck(password, salt, keylen, options) {
    password = getArrayBufferOrView(password, 'password');
    salt = getArrayBufferOrView(salt, 'salt');
    validateInt32(keylen, 'keylen', 0);
    let { N, r, p, maxmem } = scryptDefaults;
    if (options && options !== scryptDefaults) {
      const invalidParameter = () =>
        nodeError(Error, 'ERR_CRYPTO_SCRYPT_INVALID_PARAMETER', 'Invalid scrypt parameter');
      const hasN = options.N !== undefined;
      if (hasN) {
        N = options.N;
        validateUint32(N, 'N');
      }
      if (options.cost !== undefined) {
        if (hasN) throw invalidParameter();
        N = options.cost;
        validateUint32(N, 'cost');
      }
      const hasR = options.r !== undefined;
      if (hasR) {
        r = options.r;
        validateUint32(r, 'r');
      }
      if (options.blockSize !== undefined) {
        if (hasR) throw invalidParameter();
        r = options.blockSize;
        validateUint32(r, 'blockSize');
      }
      const hasP = options.p !== undefined;
      if (hasP) {
        p = options.p;
        validateUint32(p, 'p');
      }
      if (options.parallelization !== undefined) {
        if (hasP) throw invalidParameter();
        p = options.parallelization;
        validateUint32(p, 'parallelization');
      }
      if (options.maxmem !== undefined) {
        maxmem = options.maxmem;
        validateInteger(maxmem, 'maxmem', 0);
      }
      if (N === 0) N = scryptDefaults.N;
      if (r === 0) r = scryptDefaults.r;
      if (p === 0) p = scryptDefaults.p;
      if (maxmem === 0) maxmem = scryptDefaults.maxmem;
    }
    // OpenSSL's EVP_PBE_scrypt_ex parameter and memory checks.
    const invalid = (suffix = '') =>
      nativeError(RangeError, 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS', `Invalid scrypt params${suffix}`);
    if (N < 2 || (N & (N - 1)) !== 0 || p > (2 ** 30 - 1) / r) throw invalid();
    if (16 * r <= 63 && N >= 2 ** (16 * r)) throw invalid();
    if (p * 128 * r + 32 * r * (N + 2) * 4 > maxmem) {
      throw invalid(': error:030000AC:digital envelope routines::memory limit exceeded');
    }
    return { password: toU8(password), salt: toU8(salt), keylen, N, r, p };
  }
  function scryptSync(password, salt, keylen, options = scryptDefaults) {
    const o = scryptCheck(password, salt, keylen, options);
    if (o.keylen === 0) return Buffer.alloc(0);
    return toBuffer(lib.scrypt(o.password, o.salt, { N: o.N, r: o.r, p: o.p, dkLen: o.keylen, maxmem: Number.MAX_SAFE_INTEGER }));
  }
  function scrypt(password, salt, keylen, options, callback = scryptDefaults) {
    if (callback === scryptDefaults) {
      callback = options;
      options = scryptDefaults;
    }
    const o = scryptCheck(password, salt, keylen, options);
    validateFunction(callback, 'callback');
    const job =
      o.keylen === 0
        ? Promise.resolve(new Uint8Array(0))
        : lib.scryptAsync(o.password, o.salt, { N: o.N, r: o.r, p: o.p, dkLen: o.keylen, maxmem: Number.MAX_SAFE_INTEGER });
    settle(job, callback, (u8) => Buffer.from(u8));
  }

  // --- random.js ---
  const kMaxInt32 = 2 ** 31 - 1;
  const kMaxPossibleLength = Math.min(kMaxLength, kMaxInt32);
  function assertOffset(offset, elementSize, length) {
    validateNumber(offset, 'offset');
    offset *= elementSize;
    const maxLength = Math.min(length, kMaxPossibleLength);
    if (Number.isNaN(offset) || offset > maxLength || offset < 0) {
      throw ERR_OUT_OF_RANGE('offset', `>= 0 && <= ${maxLength}`, offset);
    }
    return offset >>> 0;
  }
  function assertSize(size, elementSize, offset, length) {
    validateNumber(size, 'size');
    size *= elementSize;
    if (Number.isNaN(size) || size > kMaxPossibleLength || size < 0) {
      throw ERR_OUT_OF_RANGE('size', `>= 0 && <= ${kMaxPossibleLength}`, size);
    }
    if (size + offset > length) throw ERR_OUT_OF_RANGE('size + offset', `<= ${length}`, size + offset);
    return size >>> 0;
  }
  function fillRandom(buf, offset, size) {
    const bytes = isAnyArrayBuffer(buf)
      ? new Uint8Array(buf, offset, size)
      : new Uint8Array(buf.buffer, buf.byteOffset + offset, size);
    for (let i = 0; i < bytes.length; i += 65536) web.getRandomValues(bytes.subarray(i, i + 65536));
  }
  function randomFillSync(buf, offset = 0, size) {
    if (!isAnyArrayBuffer(buf) && !isArrayBufferView(buf)) {
      throw ERR_INVALID_ARG_TYPE('buf', ['ArrayBuffer', 'ArrayBufferView'], buf);
    }
    const elementSize = buf.BYTES_PER_ELEMENT || 1;
    offset = assertOffset(offset, elementSize, buf.byteLength);
    if (size === undefined) size = buf.byteLength - offset;
    else size = assertSize(size, elementSize, offset, buf.byteLength);
    if (size === 0) return buf;
    fillRandom(buf, offset, size);
    return buf;
  }
  function randomFill(buf, offset, size, callback) {
    if (!isAnyArrayBuffer(buf) && !isArrayBufferView(buf)) {
      throw ERR_INVALID_ARG_TYPE('buf', ['ArrayBuffer', 'ArrayBufferView'], buf);
    }
    const elementSize = buf.BYTES_PER_ELEMENT || 1;
    if (typeof offset === 'function') {
      callback = offset;
      offset = 0;
      size = buf.length;
    } else if (typeof size === 'function') {
      callback = size;
      size = buf.length - offset;
    } else {
      validateFunction(callback, 'callback');
    }
    offset = assertOffset(offset, elementSize, buf.byteLength);
    if (size === undefined) size = buf.byteLength - offset;
    else size = assertSize(size, elementSize, offset, buf.byteLength);
    if (size === 0) {
      callback(null, buf);
      return;
    }
    fillRandom(buf, offset, size);
    setImmediate(() => callback(null, buf));
  }
  function randomBytes(size, callback) {
    size = assertSize(size, 1, 0, Infinity);
    if (callback !== undefined) validateFunction(callback, 'callback');
    const buf = Buffer.alloc(size);
    if (callback === undefined) {
      randomFillSync(buf.buffer, buf.byteOffset, size);
      return buf;
    }
    randomFill(buf, 0, size, (error) => {
      if (error) return callback(error);
      callback(null, buf);
    });
    return undefined;
  }
  const RAND_MAX = 0xffff_ffff_ffff;
  const randomCache = Buffer.alloc(6 * 1024);
  let randomCacheOffset = randomCache.length;
  function randomInt(min, max, callback) {
    const minNotSpecified = typeof max === 'undefined' || typeof max === 'function';
    if (minNotSpecified) {
      callback = max;
      max = min;
      min = 0;
    }
    const isSync = typeof callback === 'undefined';
    if (!isSync) validateFunction(callback, 'callback');
    if (!Number.isSafeInteger(min)) throw ERR_INVALID_ARG_TYPE('min', 'a safe integer', min);
    if (!Number.isSafeInteger(max)) throw ERR_INVALID_ARG_TYPE('max', 'a safe integer', max);
    if (max <= min) throw ERR_OUT_OF_RANGE('max', `greater than the value of "min" (${min})`, max);
    const range = max - min;
    if (!(range <= RAND_MAX)) {
      throw ERR_OUT_OF_RANGE(`max${minNotSpecified ? '' : ' - min'}`, `<= ${RAND_MAX}`, range);
    }
    const randLimit = RAND_MAX - (RAND_MAX % range);
    for (;;) {
      if (randomCacheOffset === randomCache.length) {
        randomFillSync(randomCache);
        randomCacheOffset = 0;
      }
      const x = randomCache.readUIntBE(randomCacheOffset, 6);
      randomCacheOffset += 6;
      if (x < randLimit) {
        const n = (x % range) + min;
        if (isSync) return n;
        process.nextTick(callback, undefined, n);
        return undefined;
      }
    }
  }
  const hex = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
  function randomUUID(options) {
    if (options !== undefined) validateObject(options, 'options');
    const { disableEntropyCache = false } = options || {};
    validateBoolean(disableEntropyCache, 'options.disableEntropyCache');
    const b = web.getRandomValues(new Uint8Array(16));
    return (
      `${hex[b[0]]}${hex[b[1]]}${hex[b[2]]}${hex[b[3]]}-${hex[b[4]]}${hex[b[5]]}-` +
      `${hex[(b[6] & 0x0f) | 0x40]}${hex[b[7]]}-${hex[(b[8] & 0x3f) | 0x80]}${hex[b[9]]}-` +
      `${hex[b[10]]}${hex[b[11]]}${hex[b[12]]}${hex[b[13]]}${hex[b[14]]}${hex[b[15]]}`
    );
  }

  function timingSafeEqual(buf1, buf2) {
    for (const [name, v] of [
      ['buf1', buf1],
      ['buf2', buf2],
    ]) {
      if (!isAnyArrayBuffer(v) && !isArrayBufferView(v)) {
        throw nativeError(
          TypeError,
          'ERR_INVALID_ARG_TYPE',
          `The "${name}" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.`
        );
      }
    }
    const a = toU8(buf1);
    const b = toU8(buf2);
    if (a.byteLength !== b.byteLength) {
      throw nativeError(RangeError, 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH', 'Input buffers must have the same byte length');
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  const crypto = {
    // Node 22's enumerable exports, in its order.
    checkPrime: notHereCallback('crypto.checkPrime'),
    checkPrimeSync: notHere('crypto.checkPrimeSync'),
    createCipheriv: (cipher, key, iv, options) => new Cipheriv(cipher, key, iv, options),
    createDecipheriv: (cipher, key, iv, options) => new Decipheriv(cipher, key, iv, options),
    createDiffieHellman: notHere('crypto.createDiffieHellman'),
    createDiffieHellmanGroup: notHere('crypto.createDiffieHellmanGroup'),
    createECDH: notHere('crypto.createECDH'),
    createHash: (method, options) => new Hash(method, options),
    createHmac: (hmac, key, options) => new Hmac(hmac, key, options),
    createPrivateKey: notHere('crypto.createPrivateKey'),
    createPublicKey: notHere('crypto.createPublicKey'),
    createSecretKey,
    createSign: notHere('crypto.createSign'),
    createVerify: notHere('crypto.createVerify'),
    diffieHellman: notHere('crypto.diffieHellman'),
    generatePrime: notHereCallback('crypto.generatePrime'),
    generatePrimeSync: notHere('crypto.generatePrimeSync'),
    getCiphers,
    getCipherInfo,
    getCurves: () => [],
    getDiffieHellman: notHere('crypto.getDiffieHellman'),
    getHashes,
    hkdf,
    hkdfSync,
    pbkdf2,
    pbkdf2Sync,
    generateKeyPair: notHereCallback('crypto.generateKeyPair'),
    generateKeyPairSync: notHere('crypto.generateKeyPairSync'),
    generateKey,
    generateKeySync,
    privateDecrypt: notHere('crypto.privateDecrypt'),
    privateEncrypt: notHere('crypto.privateEncrypt'),
    publicDecrypt: notHere('crypto.publicDecrypt'),
    publicEncrypt: notHere('crypto.publicEncrypt'),
    randomBytes,
    randomFill,
    randomFillSync,
    randomInt,
    randomUUID,
    scrypt,
    scryptSync,
    sign: notHere('crypto.sign'),
    setEngine(id) {
      validateString(id, 'id');
      throw nodeError(Error, 'ERR_CRYPTO_ENGINE_UNKNOWN', `Engine "${id}" was not found`);
    },
    timingSafeEqual,
    getFips: () => 0,
    setFips(val) {
      if (val) throw unavailable('FIPS mode');
    },
    verify: notHere('crypto.verify'),
    hash,
    Certificate: notHere('crypto.Certificate'),
    // Node 22 removed createCipher; the export names stay, undefined.
    Cipher: undefined,
    Cipheriv,
    Decipher: undefined,
    Decipheriv,
    DiffieHellman: notHere('crypto.DiffieHellman'),
    DiffieHellmanGroup: notHere('crypto.DiffieHellmanGroup'),
    ECDH: notHere('crypto.ECDH'),
    Hash: deprecate(Hash, 'crypto.Hash constructor is deprecated.', 'DEP0179'),
    Hmac: deprecate(Hmac, 'crypto.Hmac constructor is deprecated.', 'DEP0181'),
    KeyObject,
    Sign: notHere('crypto.Sign'),
    Verify: notHere('crypto.Verify'),
    X509Certificate: notHere('crypto.X509Certificate'),
    secureHeapUsed: () => ({ total: 0, used: 0, utilization: 0, min: 0 }),
    constants: CRYPTO_CONSTANTS,
    webcrypto: web,
    subtle: web?.subtle,
    getRandomValues: (array) => web.getRandomValues(array),
  };
  // Node's deprecated, non-enumerable aliases.
  for (const [name, value] of [
    ['prng', randomBytes],
    ['pseudoRandomBytes', randomBytes],
    ['rng', randomBytes],
  ]) {
    Object.defineProperty(crypto, name, { value, enumerable: false, writable: true, configurable: true });
  }
  Object.defineProperty(crypto, 'fips', {
    get: () => 0,
    set: crypto.setFips,
    enumerable: false,
    configurable: true,
  });
  return crypto;
}

/**
 * The callback forms (generateKeyPair(type, options, callback), …): the
 * callback is checked first, as Node's, and gets the error on a later turn,
 * as a failed job reports.
 */
function notHereCallback(name) {
  return function notAvailable(...args) {
    const callback = typeof args[1] === 'function' ? args[1] : args[2];
    validateFunction(callback, 'callback');
    const err = nativeError(
      Error,
      'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
      `${name} is not available in slicc-jsh (no pure-JS implementation); use crypto.subtle where it applies`
    );
    setImmediate(() => callback(err));
  };
}

function notHere(name) {
  return function notAvailable() {
    throw nativeError(
      Error,
      'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
      `${name} is not available in slicc-jsh (no pure-JS implementation); use crypto.subtle where it applies`
    );
  };
}
