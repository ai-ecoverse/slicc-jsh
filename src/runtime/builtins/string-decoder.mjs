/**
 * string_decoder — lazy-loaded npm string_decoder (MIT), Node's own code.
 * Must remain a callable function constructor (StringDecoder.call(obj) works).
 * write/end/text accept any ArrayBufferView via Buffer.from(view.buffer, …).
 */
import { loadVendorCjs } from '../vendor-load.mjs';
import { nodeError } from '../node-errors.mjs';

const PACKAGE_ROOT = '/node_modules/@ai-ecoverse/slicc-jsh';

let cached;

function throwBufArgType(value) {
  let received = `type ${typeof value}`;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    received = `type ${typeof value} (${value})`;
  } else if (typeof value === 'string') {
    received = `type string ('${value}')`;
  } else if (value === null) {
    received = 'null';
  } else if (typeof value === 'object') {
    received = `an instance of ${value.constructor?.name || 'Object'}`;
  }
  const err = new TypeError(
    `The "buf" argument must be an instance of Buffer, TypedArray, or DataView. Received ${received}`
  );
  err.code = 'ERR_INVALID_ARG_TYPE';
  throw err;
}

export function createStringDecoder({ ctx, process, Buffer } = {}) {
  function toBuf(buf) {
    if (Buffer.isBuffer(buf)) return buf;
    if (ArrayBuffer.isView(buf)) {
      return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    throwBufArgType(buf);
  }

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
        process,
      });
      const Base = mod.StringDecoder;
      const baseWrite = Base.prototype.write;
      const baseEnd = Base.prototype.end;
      const baseText = Base.prototype.text;

      // Keep a function constructor (not class) so StringDecoder.call(obj) works
      // like Node. Map base64url → base64 (npm 1.3 lacks base64url).
      function StringDecoder(encoding) {
        // Node: non-string encodings become String(encoding) then UNKNOWN_ENCODING
        // (e.g. new StringDecoder(1) → "Unknown encoding: 1").
        const enc = encoding === undefined || encoding === null ? 'utf8' : String(encoding);
        const url = enc.toLowerCase() === 'base64url';
        const normalized = url ? 'base64' : enc;
        if (!Buffer.isEncoding(normalized)) {
          throw nodeError(TypeError, 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${enc}`);
        }
        const ret = Base.call(this, normalized);
        // base64 pieces come in whole 3-byte groups (padding only at the end),
        // so each converts to base64url on its own.
        if (url) {
          this.encoding = 'base64url';
          // npm sets base64's end/text on the instance.
          const { end, text } = this;
          this.end = function (buf) {
            return toUrl(this, end.call(this, buf));
          };
          this.text = function (buf, i) {
            return toUrl(this, text.call(this, buf, i));
          };
        }
        return ret;
      }
      const toUrl = (self, out) =>
        self.encoding === 'base64url' ? out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : out;
      StringDecoder.prototype = Object.create(Base.prototype);
      Object.setPrototypeOf(StringDecoder, Base);
      Object.defineProperty(StringDecoder, 'name', { value: 'StringDecoder' });

      function assertDecoderThis(self) {
        if (typeof self?.encoding !== 'string' || !Buffer.isBuffer(self.lastChar)) {
          const err = new TypeError('Value of "this" must be of type StringDecoder');
          err.code = 'ERR_INVALID_THIS';
          throw err;
        }
      }

      StringDecoder.prototype.write = function write(buf) {
        assertDecoderThis(this);
        return toUrl(this, baseWrite.call(this, toBuf(buf)));
      };
      StringDecoder.prototype.end = function end(buf) {
        assertDecoderThis(this);
        // npm string_decoder 1.3 leaves lastNeed set; Node clears it after end().
        const out =
          arguments.length === 0 || buf === undefined
            ? baseEnd.call(this)
            : baseEnd.call(this, toBuf(buf));
        this.lastNeed = 0;
        this.lastTotal = 0;
        return toUrl(this, out);
      };
      StringDecoder.prototype.text = function text(buf, i) {
        assertDecoderThis(this);
        return baseText.call(this, toBuf(buf), i);
      };

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
