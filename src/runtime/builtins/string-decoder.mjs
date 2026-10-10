/**
 * string_decoder — lazy-loaded npm string_decoder (MIT), Node's own code.
 * Must remain a callable function constructor (StringDecoder.call(obj) works).
 */
import { loadVendorCjs } from '../vendor-load.mjs';

const PACKAGE_ROOT = '/node_modules/@ai-ecoverse/slicc-jsh';

let cached;

export function createStringDecoder({ ctx, process, Buffer } = {}) {
  function load() {
    if (!cached) {
      if (!ctx) {
        throw new Error('string_decoder: missing kernel ctx for vendor load');
      }
      const mod = loadVendorCjs({
        ctx,
        packageRoot: PACKAGE_ROOT,
        name: 'string_decoder',
        globals: { process, Buffer },
      });
      const Base = mod.StringDecoder;
      // Keep a function constructor (not class) so StringDecoder.call(obj) works
      // like Node. Map base64url → base64 (npm 1.3 lacks base64url).
      function StringDecoder(encoding) {
        const enc = encoding === undefined || encoding === null ? 'utf8' : encoding;
        if (typeof enc !== 'string') {
          const err = new TypeError(
            `The "encoding" argument must be of type string. Received type ${typeof enc}`
          );
          err.code = 'ERR_INVALID_ARG_TYPE';
          throw err;
        }
        const normalized = enc === 'base64url' ? 'base64' : enc;
        if (!Buffer.isEncoding(normalized)) {
          const err = new TypeError(`Unknown encoding: ${enc}`);
          err.code = 'ERR_UNKNOWN_ENCODING';
          throw err;
        }
        return Base.call(this, normalized);
      }
      StringDecoder.prototype = Base.prototype;
      Object.setPrototypeOf(StringDecoder, Base);
      Object.defineProperty(StringDecoder, 'name', { value: 'StringDecoder' });
      cached = { StringDecoder };
    }
    return cached;
  }
  return {
    get StringDecoder() {
      return load().StringDecoder;
    },
  };
}
