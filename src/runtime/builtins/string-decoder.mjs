/** string_decoder.StringDecoder with incomplete UTF-8 sequence handling. */

export function createStringDecoder() {
  class StringDecoder {
    constructor(encoding = 'utf8') {
      this.encoding = encoding || 'utf8';
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
        out += new TextDecoder().decode(this._buf);
        this._buf = new Uint8Array(0);
      }
      return out;
    }
  }

  return { StringDecoder };
}
