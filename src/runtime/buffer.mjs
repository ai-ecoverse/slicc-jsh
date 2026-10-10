/**
 * Minimal Buffer compatible with the Node 22 ops we golden-test in M1
 * (from / alloc / toString / concat / byteLength / isBuffer).
 * Full feross/buffer lands with the builtins PR.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function asUint8(value, encoding = 'utf8') {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') {
    if (encoding === 'hex') {
      const clean = value.length % 2 ? `0${value}` : value;
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    if (encoding === 'base64') {
      const bin = atob(value);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
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
  if (encoding === 'hex') {
    let out = '';
    for (const b of slice) out += b.toString(16).padStart(2, '0');
    return out;
  }
  if (encoding === 'base64') {
    let s = '';
    for (const b of slice) s += String.fromCharCode(b);
    return btoa(s);
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
      if (typeof fill === 'string') {
        const bytes = asUint8(fill, encoding);
        if (bytes.length === 0) return buf;
        for (let i = 0; i < size; i++) buf[i] = bytes[i % bytes.length];
        return buf;
      }
      buf.fill(fill);
      return buf;
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

    static fromBytes(bytes) {
      const buf = new Buffer(bytes.length);
      buf.set(bytes);
      return buf;
    }

    toString(encoding = 'utf8', start = 0, end = this.length) {
      return toStringOf(this, encoding, start, end);
    }

    equals(other) {
      if (!Buffer.isBuffer(other) && !(other instanceof Uint8Array)) return false;
      if (other.length !== this.length) return false;
      for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
      return true;
    }
  }

  return Buffer;
}
