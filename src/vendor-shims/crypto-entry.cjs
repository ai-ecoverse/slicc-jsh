'use strict';
/**
 * The primitives behind slicc-jsh's `crypto` (bundled to
 * dist/vendor/crypto.cjs; Node's API layer is src/runtime/builtins/crypto.mjs):
 * @noble/hashes for digests, HMAC and the KDFs; browserify-aes and
 * browserify-des for the block ciphers.
 */
const legacy = require('@noble/hashes/legacy');
const sha2 = require('@noble/hashes/sha2');
const sha3 = require('@noble/hashes/sha3');
const { blake2b } = require('@noble/hashes/blake2b');
const { blake2s } = require('@noble/hashes/blake2s');
const { hmac } = require('@noble/hashes/hmac');
const { pbkdf2, pbkdf2Async } = require('@noble/hashes/pbkdf2');
const { hkdf } = require('@noble/hashes/hkdf');
const { scrypt, scryptAsync } = require('@noble/hashes/scrypt');
const aes = require('browserify-aes/browser');
const DES = require('browserify-des');

exports.hashes = {
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
};
exports.hmac = hmac;
exports.pbkdf2 = pbkdf2;
exports.pbkdf2Async = pbkdf2Async;
exports.hkdf = hkdf;
exports.scrypt = scrypt;
exports.scryptAsync = scryptAsync;
exports.aes = { createCipheriv: aes.createCipheriv, createDecipheriv: aes.createDecipheriv };
exports.DES = DES;
