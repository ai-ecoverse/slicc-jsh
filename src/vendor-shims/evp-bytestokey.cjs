'use strict';
// Alias for `evp_bytestokey`: only browserify-aes's createCipher (password
// based) uses it, and Node 22 removed createCipher. Keeps md5.js out.
module.exports = function EVP_BytesToKey() {
  throw new Error('EVP_BytesToKey is not available (crypto.createCipher was removed in Node 22)');
};
