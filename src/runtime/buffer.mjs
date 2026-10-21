/**
 * Buffer compatible with Node 22.
 *
 * Security (kernel Node-entry / shared allocator): never hand out uninitialized
 * memory. `allocUnsafe` / `allocUnsafeSlow` zero-fill; `poolSize` is 0 (no pool).
 */

import { inspect } from 'node-inspect-extracted';
import { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, nodeError, normalizeEncoding, validateInteger, validateString } from './node-errors.mjs';

const encoder = new TextEncoder();
const kMaxLength = 2 ** 53 - 1;
const validateOffset = (value, name, min = 0, max = kMaxLength) => validateInteger(value, name, min, max);

/** lib/buffer.js base64ByteLength. */
function base64ByteLength(str, bytes) {
  if (str.charCodeAt(bytes - 1) === 0x3d) bytes--;
  if (bytes > 1 && str.charCodeAt(bytes - 1) === 0x3d) bytes--;
  return (bytes * 3) >>> 2;
}

/** Node's byteLength for a string in a canonical encoding. */
function stringByteLength(str, enc) {
  switch (enc) {
    case 'utf16le':
      return str.length * 2;
    case 'latin1':
    case 'ascii':
      return str.length;
    case 'hex':
      return str.length >>> 1;
    case 'base64':
    case 'base64url':
      return base64ByteLength(str, str.length);
    default:
      return encoder.encode(str).length;
  }
}

/**
 * A string's bytes for write(): at most `max`, and — as Node's writers —
 * never part of a UTF-8 character or half a UTF-16 unit.
 */
function encodeForWrite(str, enc, max) {
  const bytes = encodeString(str, enc);
  if (bytes.length <= max) return bytes;
  let n = max;
  if (enc === 'utf8') {
    while (n > 0 && (bytes[n] & 0xc0) === 0x80) n--;
  } else if (enc === 'utf16le') {
    n -= n % 2;
  }
  return bytes.subarray(0, n);
}

/** lib/buffer.js bidirectionalIndexOf. */
function bidirectionalIndexOf(buffer, val, byteOffset, encoding, dir) {
  if (typeof byteOffset === 'string') {
    encoding = byteOffset;
    byteOffset = undefined;
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff;
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000;
  }
  byteOffset = +byteOffset;
  if (Number.isNaN(byteOffset)) byteOffset = dir ? 0 : buffer.length;
  byteOffset = Math.trunc(byteOffset);
  if (typeof val === 'number') return searchBytes(buffer, new Uint8Array([val >>> 0 & 0xff]), byteOffset, dir, false);
  const enc = encoding === undefined ? 'utf8' : getEncodingOps(encoding);
  if (typeof val === 'string') {
    if (enc === undefined) throw unknownEncoding(encoding);
    return searchBytes(buffer, encodeString(val, enc), byteOffset, dir, enc === 'utf16le');
  }
  if (val instanceof Uint8Array) return searchBytes(buffer, val, byteOffset, dir, enc === 'utf16le');
  throw ERR_INVALID_ARG_TYPE('value', ['number', 'string', 'Buffer', 'Uint8Array'], val);
}

/** src/node_buffer.cc IndexOfOffset. */
function indexOfOffset(length, offset, needleLength, isForward) {
  if (offset < 0) {
    if (offset + length >= 0) return length + offset;
    if (isForward || needleLength === 0) return 0;
    return -1;
  }
  if (offset + needleLength <= length) return offset;
  if (needleLength === 0) return length;
  if (isForward) return -1;
  return length - 1;
}

/** Node's IndexOfString / IndexOfBuffer / IndexOfNumber over bytes. */
function searchBytes(haystack, needle, byteOffset, isForward, ucs2) {
  const len = haystack.length;
  let opt = indexOfOffset(len, byteOffset, needle.length, isForward);
  if (needle.length === 0) return opt;
  if (len === 0 || opt <= -1) return -1;
  if (ucs2) {
    // UTF-16 code units: only even offsets, as Node compares uint16 arrays.
    if (len < 2 || needle.length < 2) return -1;
  }
  const lastStart = len - needle.length;
  if (lastStart < 0) return -1;
  const step = ucs2 ? 2 : 1;
  const matchesAt = (i) => {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) return false;
    return true;
  };
  if (isForward) {
    let i = opt;
    if (ucs2 && i % 2) i--;
    for (; i <= lastStart; i += step) if (matchesAt(i)) return i;
    return -1;
  }
  let i = Math.min(opt, lastStart);
  if (ucs2 && i % 2) i--;
  for (; i >= 0; i -= step) if (matchesAt(i)) return i;
  return -1;
}
const decoder = new TextDecoder();
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

/**
 * lib/buffer.js getEncodingOps: an encoding's canonical name (utf8,
 * utf16le, latin1, ascii, base64, base64url, hex), or undefined.
 */
function getEncodingOps(encoding) {
  encoding += '';
  const lc = encoding.toLowerCase();
  switch (encoding.length) {
    case 4:
      if (lc === 'utf8') return 'utf8';
      if (lc === 'ucs2') return 'utf16le';
      break;
    case 5:
      if (lc === 'utf-8') return 'utf8';
      if (lc === 'ascii') return 'ascii';
      if (lc === 'ucs-2') return 'utf16le';
      break;
    case 7:
      if (lc === 'utf16le') return 'utf16le';
      break;
    case 8:
      if (lc === 'utf-16le') return 'utf16le';
      break;
    case 6:
      if (lc === 'latin1' || lc === 'binary') return 'latin1';
      if (lc === 'base64') return 'base64';
      break;
    case 3:
      if (lc === 'hex') return 'hex';
      break;
    case 9:
      if (lc === 'base64url') return 'base64url';
      break;
  }
  return undefined;
}

function unknownEncoding(encoding) {
  // Node: 'Unknown encoding: %s'.
  const shown =
    typeof encoding === 'object' && encoding !== null
      ? inspect(encoding, { depth: 0, colors: false, compact: 3 })
      : String(encoding);
  return nodeError(TypeError, 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${shown}`);
}

/** The canonical encoding, or ERR_UNKNOWN_ENCODING. */
function encodingOrThrow(encoding) {
  const enc = getEncodingOps(encoding);
  if (enc === undefined) throw unknownEncoding(encoding);
  return enc;
}

// Node's base64 decoder is forgiving: both alphabets, anything else skipped,
// and it stops at the first '='.
const B64 = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) {
  B64['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
}
B64[45] = 62; // '-'
B64[95] = 63; // '_'

function fromBase64(value) {
  const sextets = new Uint8Array(value.length);
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 61) break; // '='
    const v = c < 128 ? B64[c] : -1;
    if (v >= 0) sextets[n++] = v;
  }
  const out = new Uint8Array(Math.floor(n / 4) * 3 + [0, 0, 1, 2][n % 4]);
  let o = 0;
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    const v = (sextets[i] << 18) | (sextets[i + 1] << 12) | (sextets[i + 2] << 6) | sextets[i + 3];
    out[o++] = v >> 16;
    out[o++] = (v >> 8) & 0xff;
    out[o++] = v & 0xff;
  }
  if (n - i >= 2) out[o++] = (sextets[i] << 2) | (sextets[i + 1] >> 4);
  if (n - i === 3) out[o++] = ((sextets[i + 1] & 15) << 4) | (sextets[i + 2] >> 2);
  return out;
}

function toBase64(bytes, url) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  let b64 = btoa(s);
  if (url) b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return b64;
}

function isBufView(value) {
  return value instanceof Uint8Array || ArrayBuffer.isView(value);
}

function throwBufferArgType(name, value) {
  let received;
  if (value === null) received = 'null';
  else if (typeof value === 'string') received = `type string ('${value}')`;
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    received = `type ${typeof value} (${value})`;
  } else if (typeof value === 'object') {
    received = `an instance of ${value.constructor?.name || 'Object'}`;
  } else received = `type ${typeof value}`;
  const err = new TypeError(
    `The "${name}" argument must be an instance of Buffer or Uint8Array. Received ${received}`
  );
  err.code = 'ERR_INVALID_ARG_TYPE';
  throw err;
}

function hexVal(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

/** A string's bytes in a canonical encoding (see getEncodingOps). */
function encodeString(value, enc) {
  {
    if (enc === 'hex') {
      // Node: whole pairs only, up to the first that isn't two hex digits.
      const pairs = value.length >>> 1;
      const out = new Uint8Array(pairs);
      let n = 0;
      for (; n < pairs; n++) {
        const hi = hexVal(value.charCodeAt(n * 2));
        const lo = hexVal(value.charCodeAt(n * 2 + 1));
        if (hi < 0 || lo < 0) break;
        out[n] = (hi << 4) | lo;
      }
      return n === pairs ? out : out.slice(0, n);
    }
    if (enc === 'base64' || enc === 'base64url') return fromBase64(value);
    if (enc === 'utf16le') {
      const out = new Uint8Array(value.length * 2);
      for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        out[i * 2] = c & 0xff;
        out[i * 2 + 1] = c >> 8;
      }
      return out;
    }
    if (enc === 'latin1' || enc === 'ascii' || enc === 'binary') {
      const out = new Uint8Array(value.length);
      for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
      return out;
    }
    return encoder.encode(value);
  }
}

/** Bytes of a value; a string in `encoding` (utf8 if unknown — callers check first). */
function asUint8(value, encoding = 'utf8') {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return encodeString(value, getEncodingOps(encoding ?? 'utf8') ?? 'utf8');
  if (typeof value === 'number') return new Uint8Array([value & 0xff]);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return encoder.encode(String(value));
}

/** V8's String::kMaxLength (buffer.constants.MAX_STRING_LENGTH). */
const MAX_STRING_LENGTH = 0x1fffffe8;

/** The longest string `n` bytes can decode to (what Node's StringBytes::Encode checks first). */
function encodedLength(enc, n) {
  if (enc === 'hex') return n * 2;
  if (enc === 'base64') return Math.ceil(n / 3) * 4;
  if (enc === 'base64url') return Math.ceil((n * 4) / 3);
  if (enc === 'utf16le') return Math.floor(n / 2);
  return n;
}

function toStringOf(bytes, enc = 'utf8', start = 0, end = bytes.length) {
  // Node refuses before decoding (no huge intermediate first).
  if (encodedLength(enc, end - start) > MAX_STRING_LENGTH) {
    const e = new Error('Cannot create a string longer than 0x1fffffe8 characters');
    e.code = 'ERR_STRING_TOO_LONG';
    throw e;
  }
  const slice = bytes.subarray(start, end);
  if (enc === 'hex') {
    let out = '';
    for (const b of slice) out += b.toString(16).padStart(2, '0');
    return out;
  }
  if (enc === 'base64') return toBase64(slice, false);
  if (enc === 'base64url') return toBase64(slice, true);
  if (enc === 'utf16le') {
    let out = '';
    for (let i = 0; i + 1 < slice.length; i += 2) {
      out += String.fromCharCode(slice[i] | (slice[i + 1] << 8));
    }
    return out;
  }
  if (enc === 'latin1' || enc === 'ascii') {
    // Node's ascii decoder drops each byte's high bit.
    const mask = enc === 'ascii' ? 0x7f : 0xff;
    let out = '';
    for (const b of slice) out += String.fromCharCode(b & mask);
    return out;
  }
  return decoder.decode(slice);
}

// --- Node 22.22.0-compatible Buffer integer/float read/write (lib/internal/buffer.js) ---

const float32Array = new Float32Array(1);
const uInt8Float32Array = new Uint8Array(float32Array.buffer);
const float64Array = new Float64Array(1);
const uInt8Float64Array = new Uint8Array(float64Array.buffer);
float32Array[0] = -1;
const bufferBigEndian = uInt8Float32Array[3] === 0;

function bufferOutOfRange(name, range, value) {
  const err = new RangeError(
    `The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`
  );
  err.code = 'ERR_OUT_OF_RANGE';
  throw err;
}

function bufferOutOfBounds() {
  const err = new RangeError('Attempt to access memory outside buffer bounds');
  err.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
  throw err;
}

function bufferInvalidArgType(name, expected, value) {
  let received;
  if (value === undefined) received = 'undefined';
  else if (typeof value === 'string') received = `type string ('${value}')`;
  else received = `type ${typeof value}`;
  const err = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received}`);
  err.code = 'ERR_INVALID_ARG_TYPE';
  throw err;
}

function validateBufferNumber(value, name) {
  if (typeof value !== 'number') {
    bufferInvalidArgType(name, 'number', value);
  }
}

function boundsError(value, length, type) {
  if (Math.floor(value) !== value) {
    validateBufferNumber(value, type || 'offset');
    bufferOutOfRange(type || 'offset', 'an integer', value);
  }
  if (length < 0) bufferOutOfBounds();
  const min = type ? 1 : 0;
  bufferOutOfRange(type || 'offset', `>= ${min} and <= ${length}`, value);
}

function checkBounds(buf, offset, byteLength) {
  validateBufferNumber(offset, 'offset');
  if (buf[offset] === undefined || buf[offset + byteLength] === undefined) {
    boundsError(offset, buf.length - (byteLength + 1));
  }
}

function checkInt(value, min, max, buf, offset, byteLength) {
  if (value > max || value < min) {
    const n = typeof min === 'bigint' ? 'n' : '';
    let range;
    if (byteLength > 3) {
      if (min === 0 || min === 0n) {
        range = `>= 0${n} and < 2${n} ** ${(byteLength + 1) * 8}${n}`;
      } else {
        range =
          `>= -(2${n} ** ${(byteLength + 1) * 8 - 1}${n}) and ` +
          `< 2${n} ** ${(byteLength + 1) * 8 - 1}${n}`;
      }
    } else {
      range = `>= ${min}${n} and <= ${max}${n}`;
    }
    bufferOutOfRange('value', range, value);
  }
  checkBounds(buf, offset, byteLength);
}

function readBounds(buf, offset, size) {
  validateBufferNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + size - 1];
  if (first === undefined || last === undefined) {
    boundsError(offset, buf.length - size);
  }
}

function readUInt48LE(buf, offset = 0) {
  readBounds(buf, offset, 6);
  let o = offset;
  const last = buf[offset + 5];
  return (
    buf[o] +
    buf[++o] * 2 ** 8 +
    buf[++o] * 2 ** 16 +
    buf[++o] * 2 ** 24 +
    (buf[++o] + last * 2 ** 8) * 2 ** 32
  );
}

function readUInt40LE(buf, offset = 0) {
  readBounds(buf, offset, 5);
  let o = offset;
  return (
    buf[o] +
    buf[++o] * 2 ** 8 +
    buf[++o] * 2 ** 16 +
    buf[++o] * 2 ** 24 +
    buf[offset + 4] * 2 ** 32
  );
}

function readUInt24LE(buf, offset = 0) {
  readBounds(buf, offset, 3);
  return buf[offset] + buf[offset + 1] * 2 ** 8 + buf[offset + 2] * 2 ** 16;
}

function readUInt48BE(buf, offset = 0) {
  readBounds(buf, offset, 6);
  let o = offset;
  const last = buf[offset + 5];
  return (
    (buf[o] * 2 ** 8 + buf[++o]) * 2 ** 32 +
    buf[++o] * 2 ** 24 +
    buf[++o] * 2 ** 16 +
    buf[++o] * 2 ** 8 +
    last
  );
}

function readUInt40BE(buf, offset = 0) {
  readBounds(buf, offset, 5);
  let o = offset;
  return (
    buf[o] * 2 ** 32 +
    buf[++o] * 2 ** 24 +
    buf[++o] * 2 ** 16 +
    buf[++o] * 2 ** 8 +
    buf[offset + 4]
  );
}

function readUInt24BE(buf, offset = 0) {
  readBounds(buf, offset, 3);
  return buf[offset] * 2 ** 16 + buf[offset + 1] * 2 ** 8 + buf[offset + 2];
}

function readInt48LE(buf, offset = 0) {
  readBounds(buf, offset, 6);
  let o = offset;
  const last = buf[offset + 5];
  const val = buf[offset + 4] + last * 2 ** 8;
  return (
    (val | (val & 2 ** 15) * 0x1fffe) * 2 ** 32 +
    buf[o] +
    buf[++o] * 2 ** 8 +
    buf[++o] * 2 ** 16 +
    buf[++o] * 2 ** 24
  );
}

function readInt40LE(buf, offset = 0) {
  readBounds(buf, offset, 5);
  let o = offset;
  const last = buf[offset + 4];
  return (
    (last | (last & 2 ** 7) * 0x1fffffe) * 2 ** 32 +
    buf[o] +
    buf[++o] * 2 ** 8 +
    buf[++o] * 2 ** 16 +
    buf[++o] * 2 ** 24
  );
}

function readInt24LE(buf, offset = 0) {
  readBounds(buf, offset, 3);
  const val = buf[offset] + buf[offset + 1] * 2 ** 8 + buf[offset + 2] * 2 ** 16;
  return val | (val & 2 ** 23) * 0x1fe;
}

function readInt48BE(buf, offset = 0) {
  readBounds(buf, offset, 6);
  let o = offset;
  const last = buf[offset + 5];
  const val = buf[++o] + buf[offset] * 2 ** 8;
  return (
    (val | (val & 2 ** 15) * 0x1fffe) * 2 ** 32 +
    buf[++o] * 2 ** 24 +
    buf[++o] * 2 ** 16 +
    buf[++o] * 2 ** 8 +
    last
  );
}

function readInt40BE(buf, offset = 0) {
  readBounds(buf, offset, 5);
  let o = offset;
  const last = buf[offset + 4];
  return (
    (buf[o] | (buf[o] & 2 ** 7) * 0x1fffffe) * 2 ** 32 +
    buf[++o] * 2 ** 24 +
    buf[++o] * 2 ** 16 +
    buf[++o] * 2 ** 8 +
    last
  );
}

function readInt24BE(buf, offset = 0) {
  readBounds(buf, offset, 3);
  const val = buf[offset] * 2 ** 16 + buf[offset + 1] * 2 ** 8 + buf[offset + 2];
  return val | (val & 2 ** 23) * 0x1fe;
}

function writeU_Int48LE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 5);
  const newVal = Math.floor(value * 2 ** -32);
  let o = offset;
  buf[o++] = value;
  value >>>= 8;
  buf[o++] = value;
  value >>>= 8;
  buf[o++] = value;
  value >>>= 8;
  buf[o++] = value;
  buf[o++] = newVal;
  buf[o++] = newVal >>> 8;
  return o;
}

function writeU_Int40LE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 4);
  const newVal = value;
  let o = offset;
  buf[o++] = value;
  value >>>= 8;
  buf[o++] = value;
  value >>>= 8;
  buf[o++] = value;
  value >>>= 8;
  buf[o++] = value;
  buf[o++] = Math.floor(newVal * 2 ** -32);
  return o;
}

function writeU_Int32LE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 3);
  let o = offset;
  buf[o++] = value;
  value >>>= 8;
  buf[o++] = value;
  value >>>= 8;
  buf[o++] = value;
  value >>>= 8;
  buf[o++] = value;
  return o;
}

function writeU_Int24LE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 2);
  let o = offset;
  buf[o++] = value;
  value >>>= 8;
  buf[o++] = value;
  value >>>= 8;
  buf[o++] = value;
  return o;
}

function writeU_Int16LE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 1);
  let o = offset;
  buf[o++] = value;
  buf[o++] = value >>> 8;
  return o;
}

function writeU_Int8(buf, value, offset, min, max) {
  value = +value;
  validateBufferNumber(offset, 'offset');
  if (value > max || value < min) {
    bufferOutOfRange('value', `>= ${min} and <= ${max}`, value);
  }
  if (buf[offset] === undefined) boundsError(offset, buf.length - 1);
  buf[offset] = value;
  return offset + 1;
}

function writeU_Int48BE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 5);
  const newVal = Math.floor(value * 2 ** -32);
  let o = offset;
  buf[o++] = newVal >>> 8;
  buf[o++] = newVal;
  buf[o + 3] = value;
  value >>>= 8;
  buf[o + 2] = value;
  value >>>= 8;
  buf[o + 1] = value;
  value >>>= 8;
  buf[o] = value;
  return o + 4;
}

function writeU_Int40BE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 4);
  let o = offset;
  buf[o++] = Math.floor(value * 2 ** -32);
  buf[o + 3] = value;
  value >>>= 8;
  buf[o + 2] = value;
  value >>>= 8;
  buf[o + 1] = value;
  value >>>= 8;
  buf[o] = value;
  return o + 4;
}

function writeU_Int32BE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 3);
  buf[offset + 3] = value;
  value >>>= 8;
  buf[offset + 2] = value;
  value >>>= 8;
  buf[offset + 1] = value;
  value >>>= 8;
  buf[offset] = value;
  return offset + 4;
}

function writeU_Int24BE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 2);
  buf[offset + 2] = value;
  value >>>= 8;
  buf[offset + 1] = value;
  value >>>= 8;
  buf[offset] = value;
  return offset + 3;
}

function writeU_Int16BE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 1);
  let o = offset;
  buf[o++] = value >>> 8;
  buf[o++] = value;
  return o;
}

function writeBigU_Int64LE(buf, value, offset, min, max) {
  const bi = BigInt(value);
  checkInt(bi, min, max, buf, offset, 7);
  let lo = Number(bi & 0xffffffffn);
  let o = offset;
  buf[o++] = lo;
  lo >>= 8;
  buf[o++] = lo;
  lo >>= 8;
  buf[o++] = lo;
  lo >>= 8;
  buf[o++] = lo;
  let hi = Number((bi >> 32n) & 0xffffffffn);
  buf[o++] = hi;
  hi >>= 8;
  buf[o++] = hi;
  hi >>= 8;
  buf[o++] = hi;
  hi >>= 8;
  buf[o++] = hi;
  return o;
}

function writeBigU_Int64BE(buf, value, offset, min, max) {
  const bi = BigInt(value);
  checkInt(bi, min, max, buf, offset, 7);
  let lo = Number(bi & 0xffffffffn);
  buf[offset + 7] = lo;
  lo >>= 8;
  buf[offset + 6] = lo;
  lo >>= 8;
  buf[offset + 5] = lo;
  lo >>= 8;
  buf[offset + 4] = lo;
  let hi = Number((bi >> 32n) & 0xffffffffn);
  buf[offset + 3] = hi;
  hi >>= 8;
  buf[offset + 2] = hi;
  hi >>= 8;
  buf[offset + 1] = hi;
  hi >>= 8;
  buf[offset] = hi;
  return offset + 8;
}

function readBigUInt64LE(buf, offset = 0) {
  readBounds(buf, offset, 8);
  let o = offset;
  const last = buf[offset + 7];
  const lo =
    buf[o] + buf[++o] * 2 ** 8 + buf[++o] * 2 ** 16 + buf[++o] * 2 ** 24;
  const hi = buf[++o] + buf[++o] * 2 ** 8 + buf[++o] * 2 ** 16 + last * 2 ** 24;
  return BigInt(lo) + (BigInt(hi) << 32n);
}

function readBigUInt64BE(buf, offset = 0) {
  readBounds(buf, offset, 8);
  let o = offset;
  const last = buf[offset + 7];
  const hi =
    buf[o] * 2 ** 24 + buf[++o] * 2 ** 16 + buf[++o] * 2 ** 8 + buf[++o];
  const lo =
    buf[++o] * 2 ** 24 + buf[++o] * 2 ** 16 + buf[++o] * 2 ** 8 + last;
  return (BigInt(hi) << 32n) + BigInt(lo);
}

function readBigInt64LE(buf, offset = 0) {
  readBounds(buf, offset, 8);
  let o = offset;
  const last = buf[offset + 7];
  const val = buf[offset + 4] + buf[offset + 5] * 2 ** 8 + buf[offset + 6] * 2 ** 16 + (last << 24);
  return (
    (BigInt(val) << 32n) +
    BigInt(buf[o] + buf[++o] * 2 ** 8 + buf[++o] * 2 ** 16 + buf[++o] * 2 ** 24)
  );
}

function readBigInt64BE(buf, offset = 0) {
  readBounds(buf, offset, 8);
  let o = offset;
  const last = buf[offset + 7];
  const val =
    (buf[o] << 24) + buf[++o] * 2 ** 16 + buf[++o] * 2 ** 8 + buf[++o];
  return (
    (BigInt(val) << 32n) +
    BigInt(buf[++o] * 2 ** 24 + buf[++o] * 2 ** 16 + buf[++o] * 2 ** 8 + last)
  );
}

function readFloatForwards(buf, offset = 0) {
  readBounds(buf, offset, 4);
  let o = offset;
  uInt8Float32Array[0] = buf[o++];
  uInt8Float32Array[1] = buf[o++];
  uInt8Float32Array[2] = buf[o++];
  uInt8Float32Array[3] = buf[o];
  return float32Array[0];
}

function readFloatBackwards(buf, offset = 0) {
  readBounds(buf, offset, 4);
  let o = offset;
  uInt8Float32Array[3] = buf[o++];
  uInt8Float32Array[2] = buf[o++];
  uInt8Float32Array[1] = buf[o++];
  uInt8Float32Array[0] = buf[o];
  return float32Array[0];
}

function readDoubleForwards(buf, offset = 0) {
  readBounds(buf, offset, 8);
  let o = offset;
  uInt8Float64Array[0] = buf[o++];
  uInt8Float64Array[1] = buf[o++];
  uInt8Float64Array[2] = buf[o++];
  uInt8Float64Array[3] = buf[o++];
  uInt8Float64Array[4] = buf[o++];
  uInt8Float64Array[5] = buf[o++];
  uInt8Float64Array[6] = buf[o++];
  uInt8Float64Array[7] = buf[o];
  return float64Array[0];
}

function readDoubleBackwards(buf, offset = 0) {
  readBounds(buf, offset, 8);
  let o = offset;
  uInt8Float64Array[7] = buf[o++];
  uInt8Float64Array[6] = buf[o++];
  uInt8Float64Array[5] = buf[o++];
  uInt8Float64Array[4] = buf[o++];
  uInt8Float64Array[3] = buf[o++];
  uInt8Float64Array[2] = buf[o++];
  uInt8Float64Array[1] = buf[o++];
  uInt8Float64Array[0] = buf[o];
  return float64Array[0];
}

function writeFloatForwards(buf, val, offset = 0) {
  val = +val;
  checkBounds(buf, offset, 3);
  float32Array[0] = val;
  let o = offset;
  buf[o++] = uInt8Float32Array[0];
  buf[o++] = uInt8Float32Array[1];
  buf[o++] = uInt8Float32Array[2];
  buf[o++] = uInt8Float32Array[3];
  return o;
}

function writeFloatBackwards(buf, val, offset = 0) {
  val = +val;
  checkBounds(buf, offset, 3);
  float32Array[0] = val;
  let o = offset;
  buf[o++] = uInt8Float32Array[3];
  buf[o++] = uInt8Float32Array[2];
  buf[o++] = uInt8Float32Array[1];
  buf[o++] = uInt8Float32Array[0];
  return o;
}

function writeDoubleForwards(buf, val, offset = 0) {
  val = +val;
  checkBounds(buf, offset, 7);
  float64Array[0] = val;
  let o = offset;
  for (let i = 0; i < 8; i++) buf[o++] = uInt8Float64Array[i];
  return o;
}

function writeDoubleBackwards(buf, val, offset = 0) {
  val = +val;
  checkBounds(buf, offset, 7);
  float64Array[0] = val;
  let o = offset;
  for (let i = 7; i >= 0; i--) buf[o++] = uInt8Float64Array[i];
  return o;
}

const readFloatLE = bufferBigEndian ? readFloatBackwards : readFloatForwards;
const readFloatBE = bufferBigEndian ? readFloatForwards : readFloatBackwards;
const readDoubleLE = bufferBigEndian ? readDoubleBackwards : readDoubleForwards;
const readDoubleBE = bufferBigEndian ? readDoubleForwards : readDoubleBackwards;
const writeFloatLE = bufferBigEndian ? writeFloatBackwards : writeFloatForwards;
const writeFloatBE = bufferBigEndian ? writeFloatForwards : writeFloatBackwards;
const writeDoubleLE = bufferBigEndian ? writeDoubleBackwards : writeDoubleForwards;
const writeDoubleBE = bufferBigEndian ? writeDoubleForwards : writeDoubleBackwards;

function readUIntLE(buf, offset, byteLength) {
  if (offset === undefined) bufferInvalidArgType('offset', 'number', offset);
  if (byteLength === 6) return readUInt48LE(buf, offset);
  if (byteLength === 5) return readUInt40LE(buf, offset);
  if (byteLength === 3) return readUInt24LE(buf, offset);
  if (byteLength === 4) return buf.readUInt32LE(offset);
  if (byteLength === 2) return buf.readUInt16LE(offset);
  if (byteLength === 1) return buf.readUInt8(offset);
  boundsError(byteLength, 6, 'byteLength');
}

function readUIntBE(buf, offset, byteLength) {
  if (offset === undefined) bufferInvalidArgType('offset', 'number', offset);
  if (byteLength === 6) return readUInt48BE(buf, offset);
  if (byteLength === 5) return readUInt40BE(buf, offset);
  if (byteLength === 3) return readUInt24BE(buf, offset);
  if (byteLength === 4) return buf.readUInt32BE(offset);
  if (byteLength === 2) return buf.readUInt16BE(offset);
  if (byteLength === 1) return buf.readUInt8(offset);
  boundsError(byteLength, 6, 'byteLength');
}

function readIntLE(buf, offset, byteLength) {
  if (offset === undefined) bufferInvalidArgType('offset', 'number', offset);
  if (byteLength === 6) return readInt48LE(buf, offset);
  if (byteLength === 5) return readInt40LE(buf, offset);
  if (byteLength === 3) return readInt24LE(buf, offset);
  if (byteLength === 4) return buf.readInt32LE(offset);
  if (byteLength === 2) return buf.readInt16LE(offset);
  if (byteLength === 1) return buf.readInt8(offset);
  boundsError(byteLength, 6, 'byteLength');
}

function readIntBE(buf, offset, byteLength) {
  if (offset === undefined) bufferInvalidArgType('offset', 'number', offset);
  if (byteLength === 6) return readInt48BE(buf, offset);
  if (byteLength === 5) return readInt40BE(buf, offset);
  if (byteLength === 3) return readInt24BE(buf, offset);
  if (byteLength === 4) return buf.readInt32BE(offset);
  if (byteLength === 2) return buf.readInt16BE(offset);
  if (byteLength === 1) return buf.readInt8(offset);
  boundsError(byteLength, 6, 'byteLength');
}

function writeUIntLE(buf, value, offset, byteLength) {
  if (byteLength === 6) return writeU_Int48LE(buf, value, offset, 0, 0xffffffffffff);
  if (byteLength === 5) return writeU_Int40LE(buf, value, offset, 0, 0xffffffffff);
  if (byteLength === 3) return writeU_Int24LE(buf, value, offset, 0, 0xffffff);
  if (byteLength === 4) return writeU_Int32LE(buf, value, offset, 0, 0xffffffff);
  if (byteLength === 2) return writeU_Int16LE(buf, value, offset, 0, 0xffff);
  if (byteLength === 1) return writeU_Int8(buf, value, offset, 0, 0xff);
  boundsError(byteLength, 6, 'byteLength');
}

function writeUIntBE(buf, value, offset, byteLength) {
  if (byteLength === 6) return writeU_Int48BE(buf, value, offset, 0, 0xffffffffffff);
  if (byteLength === 5) return writeU_Int40BE(buf, value, offset, 0, 0xffffffffff);
  if (byteLength === 3) return writeU_Int24BE(buf, value, offset, 0, 0xffffff);
  if (byteLength === 4) return writeU_Int32BE(buf, value, offset, 0, 0xffffffff);
  if (byteLength === 2) return writeU_Int16BE(buf, value, offset, 0, 0xffff);
  if (byteLength === 1) return writeU_Int8(buf, value, offset, 0, 0xff);
  boundsError(byteLength, 6, 'byteLength');
}

function writeIntLE(buf, value, offset, byteLength) {
  if (byteLength === 6) return writeU_Int48LE(buf, value, offset, -0x800000000000, 0x7fffffffffff);
  if (byteLength === 5) return writeU_Int40LE(buf, value, offset, -0x8000000000, 0x7fffffffff);
  if (byteLength === 3) return writeU_Int24LE(buf, value, offset, -0x800000, 0x7fffff);
  if (byteLength === 4) return writeU_Int32LE(buf, value, offset, -0x80000000, 0x7fffffff);
  if (byteLength === 2) return writeU_Int16LE(buf, value, offset, -0x8000, 0x7fff);
  if (byteLength === 1) return writeU_Int8(buf, value, offset, -0x80, 0x7f);
  boundsError(byteLength, 6, 'byteLength');
}

function writeIntBE(buf, value, offset, byteLength) {
  if (byteLength === 6) return writeU_Int48BE(buf, value, offset, -0x800000000000, 0x7fffffffffff);
  if (byteLength === 5) return writeU_Int40BE(buf, value, offset, -0x8000000000, 0x7fffffffff);
  if (byteLength === 3) return writeU_Int24BE(buf, value, offset, -0x800000, 0x7fffff);
  if (byteLength === 4) return writeU_Int32BE(buf, value, offset, -0x80000000, 0x7fffffff);
  if (byteLength === 2) return writeU_Int16BE(buf, value, offset, -0x8000, 0x7fff);
  if (byteLength === 1) return writeU_Int8(buf, value, offset, -0x80, 0x7f);
  boundsError(byteLength, 6, 'byteLength');
}

function assertAllocSize(size) {
  if (typeof size !== 'number' || size < 0 || size > Number.MAX_SAFE_INTEGER || !Number.isFinite(size)) {
    const e = new RangeError(
      `The value of "size" is out of range. It must be >= 0 && <= ${Number.MAX_SAFE_INTEGER}. Received ${size}`
    );
    e.code = 'ERR_OUT_OF_RANGE';
    throw e;
  }
  return Math.floor(size);
}

/** Buffer class → the bytes its live allocations hold (see bufferBytes). */
const allocated = new WeakMap();

/**
 * Bytes held by the ArrayBuffers this realm's Buffers allocated that are
 * still alive: process.memoryUsage()'s `arrayBuffers` when the kernel can't
 * measure it. As on Node, memory transferred away still counts, but only
 * while the detached Buffer lives. Views (Buffer.from(arrayBuffer),
 * subarray) allocate nothing and count nothing, and neither do Buffers under
 * 4 KiB or a plain `new Uint8Array(n)`, so this is a lower bound of Node's
 * figure.
 */
export function bufferBytes(Buffer) {
  return allocated.get(Buffer)?.() ?? 0;
}

export function createBuffer({ track = true } = {}) {
  let held = 0;
  const freed = new FinalizationRegistry((bytes) => {
    held -= bytes;
  });
  class Buffer extends Uint8Array {
    /** No shared pool — matches kernel Node-entry (process workers share the allocator). */
    static poolSize = 0;

    constructor(...args) {
      super(...args);
      // New memory only when made by length (alloc, allocUnsafe, from and
      // concat copies, species of map/filter/slice). From 4 KiB: tracking
      // every small Buffer slows a tight allocation loop several times over,
      // for bytes that barely move the figure.
      if (track && typeof args[0] === 'number' && args[0] >= 4096) {
        held += this.buffer.byteLength;
        freed.register(this.buffer, this.buffer.byteLength);
      }
    }

    static from(value, encodingOrOffset, length) {
      if (typeof value === 'string') {
        // lib/buffer.js fromString: a non-string or empty encoding is utf8.
        const encoding = encodingOrOffset;
        const enc =
          !encoding || encoding === 'utf8' || typeof encoding !== 'string' ? 'utf8' : encodingOrThrow(encoding);
        return Buffer.fromBytes(encodeString(value, enc));
      }
      if (typeof value === 'number') {
        const e = new TypeError(
          'The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received type number'
        );
        e.code = 'ERR_INVALID_ARG_TYPE';
        throw e;
      }
      if (
        value instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer)
      ) {
        const offset = encodingOrOffset ?? 0;
        const len = length ?? value.byteLength - offset;
        // Node: a view on the ArrayBuffer, not a copy.
        return new Buffer(value, offset, len);
      }
      if (value instanceof Uint8Array || Array.isArray(value) || ArrayBuffer.isView(value)) {
        return Buffer.fromBytes(asUint8(value));
      }
      if (value != null && typeof value === 'object') {
        // Array-like with length number is ok; plain {} is not.
        const len = value.length;
        if (typeof len === 'number' && len >= 0) return Buffer.fromBytes(asUint8(value));
        const e = new TypeError(
          'The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received an instance of Object'
        );
        e.code = 'ERR_INVALID_ARG_TYPE';
        throw e;
      }
      return Buffer.fromBytes(asUint8(value));
    }

    static alloc(size, fill = 0, encoding = 'utf8') {
      const n = assertAllocSize(size);
      // Made at its size (zeroed), not copied from a scratch array.
      const buf = new Buffer(n);
      if (n === 0 || fill === 0) return buf;
      return buf.fill(fill, 0, n, encoding);
    }

    /** Zero-fills (never exposes prior allocator contents). */
    static allocUnsafe(size) {
      const n = assertAllocSize(size);
      return new Buffer(n);
    }

    /** Same as allocUnsafe when poolSize is 0. */
    static allocUnsafeSlow(size) {
      return Buffer.allocUnsafe(size);
    }

    static concat(list, totalLength) {
      const parts = list.map((item) => (item instanceof Uint8Array ? item : asUint8(item)));
      let length = totalLength;
      if (length === undefined) {
        length = 0;
        for (const p of parts) length += p.length;
      }
      const out = Buffer.fromBytes(new Uint8Array(length));
      let at = 0;
      for (const p of parts) {
        const n = Math.min(p.length, length - at);
        out.set(p.subarray(0, n), at);
        at += n;
        if (at >= length) break;
      }
      return out;
    }

    static byteLength(value, encoding) {
      if (typeof value !== 'string') {
        if (
          ArrayBuffer.isView(value) ||
          value instanceof ArrayBuffer ||
          (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer)
        ) {
          return value.byteLength;
        }
        throw ERR_INVALID_ARG_TYPE('string', ['string', 'Buffer', 'ArrayBuffer'], value);
      }
      if (value.length === 0) return 0;
      // Node: an unknown encoding counts as utf8 (no throw).
      const enc = !encoding ? 'utf8' : (getEncodingOps(encoding) ?? 'utf8');
      return stringByteLength(value, enc);
    }

    static isBuffer(value) {
      return value instanceof Buffer;
    }

    static isEncoding(encoding) {
      if (typeof encoding !== 'string') return false;
      switch (encoding.toLowerCase()) {
        case 'utf8':
        case 'utf-8':
        case 'utf16le':
        case 'utf-16le':
        case 'ucs2':
        case 'ucs-2':
        case 'latin1':
        case 'binary':
        case 'base64':
        case 'base64url':
        case 'hex':
        case 'ascii':
          return true;
        default:
          return false;
      }
    }

    static compare(a, b) {
      if (!isBufView(a)) throwBufferArgType('buf1', a);
      if (!isBufView(b)) throwBufferArgType('buf2', b);
      const aa = a;
      const bb = b;
      const len = Math.min(aa.length, bb.length);
      for (let i = 0; i < len; i++) {
        if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
      }
      return aa.length === bb.length ? 0 : aa.length < bb.length ? -1 : 1;
    }

    static fromBytes(bytes) {
      const buf = new Buffer(bytes.length);
      buf.set(bytes);
      return buf;
    }

    toString(encoding, start, end) {
      if (arguments.length === 0) return toStringOf(this, 'utf8', 0, this.length);
      const len = this.length;
      if (start <= 0) start = 0;
      else if (start >= len) return '';
      else start = Math.trunc(start) || 0;
      if (end === undefined || end > len) end = len;
      else end = Math.trunc(end) || 0;
      if (end <= start) return '';
      if (encoding === undefined) return toStringOf(this, 'utf8', start, end);
      return toStringOf(this, encodingOrThrow(encoding), start, end);
    }

    equals(other) {
      if (!isBufView(other)) throwBufferArgType('otherBuffer', other);
      return Buffer.compare(this, other) === 0;
    }

    copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
      const start = sourceStart >>> 0;
      const end = sourceEnd === undefined ? this.length : sourceEnd >>> 0;
      const tStart = targetStart >>> 0;
      const len = Math.max(0, Math.min(end, this.length) - start);
      const max = Math.min(len, (target.length >>> 0) - tStart);
      if (max <= 0) return 0;
      target.set(this.subarray(start, start + max), tStart);
      return max;
    }

    /** lib/buffer.js Buffer.prototype.write. */
    write(string, offset, length, encoding) {
      if (typeof string !== 'string') {
        // Node's C++ writer: a plain message.
        const e = new TypeError('argument must be a string');
        e.code = 'ERR_INVALID_ARG_TYPE';
        throw e;
      }
      if (offset === undefined) {
        offset = 0;
        length = this.length;
      } else if (length === undefined && typeof offset === 'string') {
        encoding = offset;
        length = this.length;
        offset = 0;
      } else {
        validateOffset(offset, 'offset', 0, this.length);
        const remaining = this.length - offset;
        if (length === undefined) {
          length = remaining;
        } else if (typeof length === 'string') {
          encoding = length;
          length = remaining;
        } else {
          validateOffset(length, 'length', 0, this.length);
          if (length > remaining) length = remaining;
        }
      }
      const enc = !encoding || encoding === 'utf8' ? 'utf8' : encodingOrThrow(encoding);
      const bytes = encodeForWrite(string, enc, length);
      this.set(bytes, offset);
      return bytes.length;
    }

    compare(target) {
      if (!isBufView(target)) throwBufferArgType('target', target);
      return Buffer.compare(this, target);
    }

    // Node: both are views on the same memory (slice is subarray's old name).
    slice(start, end) {
      return this.subarray(start, end);
    }

    subarray(start, end) {
      const view = Uint8Array.prototype.subarray.call(this, start, end);
      return new Buffer(view.buffer, view.byteOffset, view.length);
    }

    /** lib/buffer.js _fill. */
    fill(value, offset, end, encoding) {
      let enc;
      if (typeof value === 'string') {
        if (offset === undefined || typeof offset === 'string') {
          encoding = offset;
          offset = 0;
          end = this.length;
        } else if (typeof end === 'string') {
          encoding = end;
          end = this.length;
        }
        enc = normalizeEncoding(encoding);
        if (enc === undefined) {
          validateString(encoding, 'encoding');
          throw unknownEncoding(encoding);
        }
        if (value.length === 0) value = 0;
      }
      if (offset === undefined) {
        offset = 0;
        end = this.length;
      } else {
        validateOffset(offset, 'offset');
        if (end === undefined) end = this.length;
        else validateOffset(end, 'end', 0, this.length);
        if (offset >= end) return this;
      }
      let bytes;
      if (typeof value === 'number') bytes = new Uint8Array([value & 0xff]);
      else if (typeof value === 'string') bytes = encodeString(value, enc);
      else if (typeof value === 'boolean') bytes = new Uint8Array([Number(value)]);
      else bytes = asUint8(value);
      if (offset > end || end > this.length) {
        const e = new RangeError('Attempt to access memory outside buffer bounds');
        e.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
        throw e;
      }
      if (bytes.length === 0) {
        // Node: a string (or buffer) that encodes to nothing is invalid.
        if (typeof value === 'string' || ArrayBuffer.isView(value)) throw ERR_INVALID_ARG_VALUE('value', value);
        bytes = new Uint8Array([0]);
      }
      // One byte: the typed array's own fill; a pattern: written once, then
      // doubled with copyWithin.
      if (bytes.length === 1) {
        Uint8Array.prototype.fill.call(this, bytes[0], offset, end);
        return this;
      }
      const first = Math.min(bytes.length, end - offset);
      for (let i = 0; i < first; i++) this[offset + i] = bytes[i];
      for (let filled = first; filled < end - offset; filled *= 2) {
        Uint8Array.prototype.copyWithin.call(this, offset + filled, offset, offset + Math.min(filled, end - offset - filled));
      }
      return this;
    }

    indexOf(val, byteOffset, encoding) {
      return bidirectionalIndexOf(this, val, byteOffset, encoding, true);
    }

    lastIndexOf(val, byteOffset, encoding) {
      return bidirectionalIndexOf(this, val, byteOffset, encoding, false);
    }

    includes(val, byteOffset, encoding) {
      return this.indexOf(val, byteOffset, encoding) !== -1;
    }

    readUInt8(offset = 0) {
      readBounds(this, offset, 1);
      return this[offset];
    }
    readInt8(offset = 0) {
      readBounds(this, offset, 1);
      const val = this[offset];
      return val | (val & 2 ** 7) * 0x1fffffe;
    }
    readUInt16LE(offset = 0) {
      readBounds(this, offset, 2);
      return this[offset] + this[offset + 1] * 2 ** 8;
    }
    readUInt16BE(offset = 0) {
      readBounds(this, offset, 2);
      return this[offset] * 2 ** 8 + this[offset + 1];
    }
    readInt16LE(offset = 0) {
      readBounds(this, offset, 2);
      const val = this[offset] + this[offset + 1] * 2 ** 8;
      return val | (val & 2 ** 15) * 0x1fffe;
    }
    readInt16BE(offset = 0) {
      readBounds(this, offset, 2);
      const val = this[offset] * 2 ** 8 + this[offset + 1];
      return val | (val & 2 ** 15) * 0x1fffe;
    }
    readUInt32LE(offset = 0) {
      readBounds(this, offset, 4);
      let o = offset;
      const last = this[offset + 3];
      return this[o] + this[++o] * 2 ** 8 + this[++o] * 2 ** 16 + last * 2 ** 24;
    }
    readUInt32BE(offset = 0) {
      readBounds(this, offset, 4);
      let o = offset;
      const last = this[offset + 3];
      return this[o] * 2 ** 24 + this[++o] * 2 ** 16 + this[++o] * 2 ** 8 + last;
    }
    readInt32LE(offset = 0) {
      readBounds(this, offset, 4);
      let o = offset;
      const last = this[offset + 3];
      return this[o] + this[++o] * 2 ** 8 + this[++o] * 2 ** 16 + (last << 24);
    }
    readInt32BE(offset = 0) {
      readBounds(this, offset, 4);
      let o = offset;
      const last = this[offset + 3];
      return (this[o] << 24) + this[++o] * 2 ** 16 + this[++o] * 2 ** 8 + last;
    }
    readFloatLE(offset = 0) {
      return readFloatLE(this, offset);
    }
    readFloatBE(offset = 0) {
      return readFloatBE(this, offset);
    }
    readDoubleLE(offset = 0) {
      return readDoubleLE(this, offset);
    }
    readDoubleBE(offset = 0) {
      return readDoubleBE(this, offset);
    }
    readBigUInt64LE(offset = 0) {
      return readBigUInt64LE(this, offset);
    }
    readBigUInt64BE(offset = 0) {
      return readBigUInt64BE(this, offset);
    }
    readBigInt64LE(offset = 0) {
      return readBigInt64LE(this, offset);
    }
    readBigInt64BE(offset = 0) {
      return readBigInt64BE(this, offset);
    }
    readUIntLE(offset, byteLength) {
      return readUIntLE(this, offset, byteLength);
    }
    readUIntBE(offset, byteLength) {
      return readUIntBE(this, offset, byteLength);
    }
    readIntLE(offset, byteLength) {
      return readIntLE(this, offset, byteLength);
    }
    readIntBE(offset, byteLength) {
      return readIntBE(this, offset, byteLength);
    }

    writeUInt8(value, offset = 0) {
      return writeU_Int8(this, value, offset, 0, 0xff);
    }
    writeInt8(value, offset = 0) {
      return writeU_Int8(this, value, offset, -0x80, 0x7f);
    }
    writeUInt16LE(value, offset = 0) {
      return writeU_Int16LE(this, value, offset, 0, 0xffff);
    }
    writeUInt16BE(value, offset = 0) {
      return writeU_Int16BE(this, value, offset, 0, 0xffff);
    }
    writeInt16LE(value, offset = 0) {
      return writeU_Int16LE(this, value, offset, -0x8000, 0x7fff);
    }
    writeInt16BE(value, offset = 0) {
      return writeU_Int16BE(this, value, offset, -0x8000, 0x7fff);
    }
    writeUInt32LE(value, offset = 0) {
      return writeU_Int32LE(this, value, offset, 0, 0xffffffff);
    }
    writeUInt32BE(value, offset = 0) {
      return writeU_Int32BE(this, value, offset, 0, 0xffffffff);
    }
    writeInt32LE(value, offset = 0) {
      return writeU_Int32LE(this, value, offset, -0x80000000, 0x7fffffff);
    }
    writeInt32BE(value, offset = 0) {
      return writeU_Int32BE(this, value, offset, -0x80000000, 0x7fffffff);
    }
    writeFloatLE(value, offset = 0) {
      return writeFloatLE(this, value, offset);
    }
    writeFloatBE(value, offset = 0) {
      return writeFloatBE(this, value, offset);
    }
    writeDoubleLE(value, offset = 0) {
      return writeDoubleLE(this, value, offset);
    }
    writeDoubleBE(value, offset = 0) {
      return writeDoubleBE(this, value, offset);
    }
    writeBigUInt64LE(value, offset = 0) {
      return writeBigU_Int64LE(this, value, offset, 0n, 0xffffffffffffffffn);
    }
    writeBigUInt64BE(value, offset = 0) {
      return writeBigU_Int64BE(this, value, offset, 0n, 0xffffffffffffffffn);
    }
    writeBigInt64LE(value, offset = 0) {
      return writeBigU_Int64LE(this, value, offset, -0x8000000000000000n, 0x7fffffffffffffffn);
    }
    writeBigInt64BE(value, offset = 0) {
      return writeBigU_Int64BE(this, value, offset, -0x8000000000000000n, 0x7fffffffffffffffn);
    }
    writeUIntLE(value, offset, byteLength) {
      return writeUIntLE(this, value, offset, byteLength);
    }
    writeUIntBE(value, offset, byteLength) {
      return writeUIntBE(this, value, offset, byteLength);
    }
    writeIntLE(value, offset, byteLength) {
      return writeIntLE(this, value, offset, byteLength);
    }
    writeIntBE(value, offset, byteLength) {
      return writeIntBE(this, value, offset, byteLength);
    }

    swap16() {
      for (let i = 0; i + 1 < this.length; i += 2) {
        const t = this[i];
        this[i] = this[i + 1];
        this[i + 1] = t;
      }
      return this;
    }

    toJSON() {
      return { type: 'Buffer', data: [...this] };
    }

    [INSPECT_CUSTOM](depth, opts) {
      void depth;
      void opts;
      if (this.length === 0) return '<Buffer >';
      const max = 50;
      const parts = [];
      for (let i = 0; i < Math.min(this.length, max); i++) parts.push(this[i].toString(16).padStart(2, '0'));
      const more = this.length > max ? ` ... ${this.length - max} more bytes` : '';
      return `<Buffer ${parts.join(' ')}${more}>`;
    }
  }
  // The bundler may rename the class (Buffer2); its name is Node's.
  Object.defineProperty(Buffer, 'name', { value: 'Buffer', configurable: true });
  allocated.set(Buffer, () => held);

  return Buffer;
}
