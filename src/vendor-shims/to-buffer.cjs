'use strict';
// Alias for `to-buffer` (cipher-base's input coercion), without its
// typed-array-buffer → get-intrinsic polyfill chain: same results on an engine
// with ArrayBuffer.isView and a Uint8Array-based Buffer.
const { Buffer } = require('buffer');

module.exports = function toBuffer(data, encoding) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, encoding);
  if (ArrayBuffer.isView(data)) {
    if (data.byteLength === 0) return Buffer.alloc(0);
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    for (const x of data) {
      if (typeof x !== 'number' || x < 0 || x > 255 || ~~x !== x) {
        throw new RangeError('Array items must be numbers in the range 0-255.');
      }
    }
    return Buffer.from(data);
  }
  throw new TypeError('The "data" argument must be a string, an Array, a Buffer, a Uint8Array, or a DataView.');
};
