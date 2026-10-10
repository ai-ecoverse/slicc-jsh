'use strict';
/**
 * esbuild alias target for `buffer` / `safe-buffer` inside vendor CJS bundles.
 * Evaluated while loadVendorCjs has installed jsh's Buffer on globalThis, so
 * stream chunks and StringDecoder.lastChar share the runtime Buffer class.
 */
const Buffer = globalThis.Buffer;
module.exports = Buffer;
module.exports.Buffer = Buffer;
module.exports.SlowBuffer = Buffer;
module.exports.kMaxLength = 0x7fffffff;
module.exports.INSPECT_MAX_BYTES = 50;
if (typeof globalThis.Blob !== 'undefined') {
  module.exports.Blob = globalThis.Blob;
}
