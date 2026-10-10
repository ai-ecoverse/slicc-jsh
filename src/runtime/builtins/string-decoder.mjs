/**
 * string_decoder — lazy-loaded npm string_decoder (MIT), Node's own code.
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
      // npm string_decoder@1.3 lacks base64url; Node 22 accepts it (same as base64 here).
      class StringDecoder extends Base {
        constructor(encoding) {
          const enc = encoding === 'base64url' ? 'base64' : encoding;
          super(enc);
        }
      }
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
