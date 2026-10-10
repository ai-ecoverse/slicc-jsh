/**
 * Buffer compatible with Node 22 M1 cert cases.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

function normalizeEncoding(enc) {
  if (!enc) return 'utf8';
  const e = String(enc).toLowerCase();
  if (e === 'utf-8' || e === 'utf8') return 'utf8';
  if (e === 'ucs2' || e === 'ucs-2' || e === 'utf16le' || e === 'utf-16le') return 'utf16le';
  if (e === 'latin1' || e === 'binary') return 'latin1';
  if (e === 'ascii') return 'ascii';
  if (e === 'base64url') return 'base64url';
  return e;
}

function fromBase64(value, url) {
  let s = value.replace(/\s+/g, '');
  if (url) s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes, url) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  let b64 = btoa(s);
  if (url) b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return b64;
}

function asUint8(value, encoding = 'utf8') {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') {
    const enc = normalizeEncoding(encoding);
    if (enc === 'hex') {
      const clean = value.length % 2 ? `0${value}` : value;
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    if (enc === 'base64') return fromBase64(value, false);
    if (enc === 'base64url') return fromBase64(value, true);
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
  if (typeof value === 'number') return new Uint8Array([value & 0xff]);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return encoder.encode(String(value));
}

function toStringOf(bytes, encoding = 'utf8', start = 0, end = bytes.length) {
  const slice = bytes.subarray(start, end);
  const enc = normalizeEncoding(encoding);
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
  if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') {
    let out = '';
    for (const b of slice) out += String.fromCharCode(b);
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

export function createBuffer() {
  class Buffer extends Uint8Array {
    static from(value, encodingOrOffset, length) {
      if (typeof value === 'string') return Buffer.fromBytes(asUint8(value, encodingOrOffset ?? 'utf8'));
      if (typeof value === 'number') {
        const e = new TypeError(
          'The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received type number'
        );
        e.code = 'ERR_INVALID_ARG_TYPE';
        throw e;
      }
      if (value instanceof ArrayBuffer) {
        const offset = encodingOrOffset ?? 0;
        const len = length ?? value.byteLength - offset;
        return Buffer.fromBytes(new Uint8Array(value, offset, len));
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
      if (typeof size !== 'number' || size < 0 || size > Number.MAX_SAFE_INTEGER || !Number.isFinite(size)) {
        const e = new RangeError(
          `The value of "size" is out of range. It must be >= 0 && <= ${Number.MAX_SAFE_INTEGER}. Received ${size}`
        );
        e.code = 'ERR_OUT_OF_RANGE';
        throw e;
      }
      const n = Math.floor(size);
      const buf = Buffer.fromBytes(new Uint8Array(n));
      if (n === 0) return buf;
      return buf.fill(fill, 0, n, encoding);
    }

    static allocUnsafe(size) {
      return Buffer.fromBytes(new Uint8Array(size));
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

    static byteLength(value, encoding = 'utf8') {
      if (typeof value === 'string') return asUint8(value, encoding).length;
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        return value.byteLength ?? value.length;
      }
      return asUint8(value).length;
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
      const aa = a instanceof Uint8Array ? a : asUint8(a);
      const bb = b instanceof Uint8Array ? b : asUint8(b);
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

    toString(encoding = 'utf8', start = 0, end = this.length) {
      return toStringOf(this, encoding, start, end);
    }

    equals(other) {
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

    write(string, offset = 0, length, encoding = 'utf8') {
      if (typeof offset === 'string') {
        encoding = offset;
        offset = 0;
        length = undefined;
      } else if (typeof length === 'string') {
        encoding = length;
        length = undefined;
      }
      if (typeof offset !== 'number' || !Number.isFinite(offset)) {
        const e = new TypeError(
          `The "offset" argument must be of type number. Received type ${typeof offset}${
            typeof offset === 'string' ? ` ('${offset}')` : ''
          }`
        );
        e.code = 'ERR_INVALID_ARG_TYPE';
        throw e;
      }
      if (offset < 0 || offset > this.length) {
        const e = new RangeError(
          `The value of "offset" is out of range. It must be >= 0 && <= ${this.length}. Received ${offset}`
        );
        e.code = 'ERR_OUT_OF_RANGE';
        throw e;
      }
      const bytes = asUint8(String(string), encoding);
      const max = length == null ? this.length - offset : Math.min(length, this.length - offset);
      const n = Math.min(bytes.length, max);
      this.set(bytes.subarray(0, n), offset);
      return n;
    }

    compare(other) {
      return Buffer.compare(this, other);
    }

    slice(start, end) {
      return Buffer.fromBytes(Uint8Array.prototype.slice.call(this, start, end));
    }

    subarray(start, end) {
      const view = Uint8Array.prototype.subarray.call(this, start, end);
      return Buffer.fromBytes(view);
    }

    fill(value, offset = 0, end = this.length, encoding = 'utf8') {
      if (typeof offset === 'string') {
        encoding = offset;
        offset = 0;
        end = this.length;
      } else if (typeof end === 'string') {
        encoding = end;
        end = this.length;
      }
      if (offset < 0 || offset > this.length) {
        const e = new RangeError(
          `The value of "offset" is out of range. It must be >= 0 && <= ${this.length}. Received ${offset}`
        );
        e.code = 'ERR_OUT_OF_RANGE';
        throw e;
      }
      if (end < 0 || end > this.length) {
        const e = new RangeError(
          `The value of "end" is out of range. It must be >= 0 && <= ${this.length}. Received ${end}`
        );
        e.code = 'ERR_OUT_OF_RANGE';
        throw e;
      }
      let bytes;
      if (typeof value === 'string') bytes = asUint8(value, encoding);
      else if (typeof value === 'number') bytes = new Uint8Array([value & 0xff]);
      else bytes = asUint8(value);
      if (bytes.length === 0) return this;
      for (let i = offset; i < end; i++) this[i] = bytes[(i - offset) % bytes.length];
      return this;
    }

    indexOf(value, byteOffset = 0) {
      const needle = typeof value === 'number' ? new Uint8Array([value & 0xff]) : asUint8(value);
      for (let i = byteOffset; i <= this.length - needle.length; i++) {
        let ok = true;
        for (let j = 0; j < needle.length; j++) {
          if (this[i + j] !== needle[j]) {
            ok = false;
            break;
          }
        }
        if (ok) return i;
      }
      return -1;
    }

    includes(value, byteOffset) {
      return this.indexOf(value, byteOffset) !== -1;
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

  return Buffer;
}
