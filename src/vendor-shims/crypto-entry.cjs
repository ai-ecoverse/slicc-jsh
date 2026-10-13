'use strict';
/**
 * The primitives behind slicc-jsh's `crypto` (bundled to
 * dist/vendor/crypto.cjs; Node's API layer is src/runtime/builtins/crypto.mjs):
 * @noble/hashes for digests, HMAC and the KDFs; browserify-aes and
 * browserify-des for the block ciphers; SM3 in ./sm3.cjs on noble's base.
 */
// @noble/hashes 2 is ESM with explicit `.js` subpaths (esbuild bundles it).
const legacy = require('@noble/hashes/legacy.js');
const sha2 = require('@noble/hashes/sha2.js');
const sha3 = require('@noble/hashes/sha3.js');
const { blake2b, blake2s } = require('@noble/hashes/blake2.js');
const { hmac } = require('@noble/hashes/hmac.js');
const { pbkdf2, pbkdf2Async } = require('@noble/hashes/pbkdf2.js');
const { hkdf } = require('@noble/hashes/hkdf.js');
const { scrypt, scryptAsync } = require('@noble/hashes/scrypt.js');
const { sm3 } = require('./sm3.cjs');
const aes = require('browserify-aes/browser');
const DES = require('browserify-des');

/**
 * OpenSSL's md5-sha1 (MD5 then SHA-1 of the same input, 36 bytes, a 64-byte
 * block) as a noble hash, so HMAC and the KDFs take it as Node's do.
 */
class MD5SHA1 {
  constructor() {
    this.md5 = legacy.md5.create();
    this.sha1 = legacy.sha1.create();
    this.blockLen = 64;
    this.outputLen = 36;
  }
  update(data) {
    this.md5.update(data);
    this.sha1.update(data);
    return this;
  }
  digestInto(out) {
    out.set(this.md5.digest(), 0);
    out.set(this.sha1.digest(), 16);
  }
  digest() {
    const out = new Uint8Array(36);
    this.digestInto(out);
    return out;
  }
  destroy() {
    this.md5.destroy();
    this.sha1.destroy();
  }
  _cloneInto(to) {
    to ||= new MD5SHA1();
    to.md5 = this.md5._cloneInto(to.md5);
    to.sha1 = this.sha1._cloneInto(to.sha1);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
}
const md5sha1 = Object.assign((msg) => new MD5SHA1().update(msg).digest(), {
  create: () => new MD5SHA1(),
  outputLen: 36,
  blockLen: 64,
});

exports.hashes = {
  'md5-sha1': md5sha1,
  md5: legacy.md5,
  sha1: legacy.sha1,
  ripemd160: legacy.ripemd160,
  sha224: sha2.sha224,
  sha256: sha2.sha256,
  sha384: sha2.sha384,
  sha512: sha2.sha512,
  'sha512-224': sha2.sha512_224,
  'sha512-256': sha2.sha512_256,
  'sha3-224': sha3.sha3_224,
  'sha3-256': sha3.sha3_256,
  'sha3-384': sha3.sha3_384,
  'sha3-512': sha3.sha3_512,
  shake128: sha3.shake128,
  shake256: sha3.shake256,
  blake2b512: blake2b,
  blake2s256: blake2s,
  sm3,
};
exports.hmac = hmac;
exports.pbkdf2 = pbkdf2;
exports.pbkdf2Async = pbkdf2Async;
exports.hkdf = hkdf;
exports.scrypt = scrypt;
exports.scryptAsync = scryptAsync;
exports.aes = { createCipheriv: aes.createCipheriv, createDecipheriv: aes.createDecipheriv };
exports.DES = DES;
