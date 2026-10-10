/** string_decoder.StringDecoder — utf8 / hex / base64 with incomplete-sequence buffering. */

function toBytes(buffer) {
  if (typeof buffer === 'string') return new TextEncoder().encode(buffer);
  if (buffer instanceof Uint8Array) return buffer;
  return new Uint8Array(buffer);
}

function encodeHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function encodeBase64Chunk(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function createStringDecoder() {
  class StringDecoder {
    constructor(encoding = 'utf8') {
      const e = String(encoding || 'utf8').toLowerCase();
      this.encoding = e === 'utf-8' ? 'utf8' : e;
      this._buf = new Uint8Array(0);
    }

    write(buffer) {
      const bytes = toBytes(buffer);
      if (this.encoding === 'hex') {
        // Hex has no incomplete unit beyond a single nibble; emit all.
        return encodeHex(bytes);
      }
      if (this.encoding === 'base64' || this.encoding === 'base64url') {
        const merged = new Uint8Array(this._buf.length + bytes.length);
        merged.set(this._buf);
        merged.set(bytes, this._buf.length);
        const complete = merged.length - (merged.length % 3);
        const slice = merged.subarray(0, complete);
        this._buf = merged.subarray(complete);
        let out = encodeBase64Chunk(slice);
        if (this.encoding === 'base64url') {
          out = out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
        }
        return out;
      }
      if (this.encoding === 'latin1' || this.encoding === 'binary') {
        let out = '';
        for (const b of bytes) out += String.fromCharCode(b);
        return out;
      }

      const merged = new Uint8Array(this._buf.length + bytes.length);
      merged.set(this._buf);
      merged.set(bytes, this._buf.length);

      let i = 0;
      let out = '';
      const dec = new TextDecoder('utf-8', { fatal: false });
      while (i < merged.length) {
        const b = merged[i];
        let need = 1;
        if (b >= 0xf0) need = 4;
        else if (b >= 0xe0) need = 3;
        else if (b >= 0xc0) need = 2;
        if (i + need > merged.length) {
          this._buf = merged.subarray(i);
          return out;
        }
        out += dec.decode(merged.subarray(i, i + need));
        i += need;
      }
      this._buf = new Uint8Array(0);
      return out;
    }

    end(buffer) {
      let out = buffer ? this.write(buffer) : '';
      if (this._buf.length) {
        if (this.encoding === 'base64' || this.encoding === 'base64url') {
          let rest = encodeBase64Chunk(this._buf);
          if (this.encoding === 'base64url') {
            rest = rest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
          }
          out += rest;
        } else if (this.encoding === 'utf8') {
          out += new TextDecoder().decode(this._buf);
        } else {
          out += this.write(this._buf);
        }
        this._buf = new Uint8Array(0);
      }
      return out;
    }
  }

  return { StringDecoder };
}
