/** Minimal string_decoder.StringDecoder for utf8. */

export function createStringDecoder() {
  class StringDecoder {
    constructor(encoding = 'utf8') {
      this.encoding = encoding;
      this._buf = new Uint8Array(0);
    }

    write(buffer) {
      const bytes =
        typeof buffer === 'string'
          ? new TextEncoder().encode(buffer)
          : buffer instanceof Uint8Array
            ? buffer
            : new Uint8Array(buffer);
      const merged = new Uint8Array(this._buf.length + bytes.length);
      merged.set(this._buf);
      merged.set(bytes, this._buf.length);
      // Keep incomplete UTF-8 trailers; decode the rest.
      let end = merged.length;
      while (end > 0 && end > merged.length - 4) {
        const b = merged[end - 1];
        if ((b & 0xc0) !== 0x80) break;
        end--;
      }
      // If last start byte needs more continuation bytes, hold them.
      if (end < merged.length) {
        const start = merged[end - 1];
        const need =
          start >= 0xf0 ? 4 : start >= 0xe0 ? 3 : start >= 0xc0 ? 2 : 1;
        const have = merged.length - (end - 1);
        if (have < need) {
          this._buf = merged.subarray(end - 1);
          return new TextDecoder().decode(merged.subarray(0, end - 1));
        }
      }
      this._buf = new Uint8Array(0);
      return new TextDecoder().decode(merged);
    }

    end(buffer) {
      const out = buffer ? this.write(buffer) : '';
      const rest = this._buf.length ? new TextDecoder().decode(this._buf) : '';
      this._buf = new Uint8Array(0);
      return out + rest;
    }
  }

  return { StringDecoder };
}
