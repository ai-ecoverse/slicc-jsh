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

export function createBuffer() {
  class Buffer extends Uint8Array {
    static from(value, encodingOrOffset, length) {
      if (typeof value === 'string') return Buffer.fromBytes(asUint8(value, encodingOrOffset ?? 'utf8'));
      if (typeof value === 'number') {
        throw new TypeError(
          'The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received type number'
        );
      }
      if (value instanceof ArrayBuffer) {
        const offset = encodingOrOffset ?? 0;
        const len = length ?? value.byteLength - offset;
        return Buffer.fromBytes(new Uint8Array(value, offset, len));
      }
      return Buffer.fromBytes(asUint8(value));
    }

    static alloc(size, fill = 0, encoding = 'utf8') {
      const buf = Buffer.fromBytes(new Uint8Array(size));
      if (size === 0) return buf;
      return buf.fill(fill, 0, size, encoding);
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

    readUInt16BE(offset = 0) {
      return (this[offset] << 8) | this[offset + 1];
    }

    readInt32LE(offset = 0) {
      return (
        this[offset] |
        (this[offset + 1] << 8) |
        (this[offset + 2] << 16) |
        (this[offset + 3] << 24)
      );
    }

    writeUInt32BE(value, offset = 0) {
      this[offset] = (value >>> 24) & 0xff;
      this[offset + 1] = (value >>> 16) & 0xff;
      this[offset + 2] = (value >>> 8) & 0xff;
      this[offset + 3] = value & 0xff;
      return offset + 4;
    }

    writeDoubleLE() {
      return 0;
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
