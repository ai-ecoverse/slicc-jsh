/** Minimal querystring parse/stringify. */

export function createQuerystring() {
  return {
    parse(str, sep = '&', eq = '=') {
      const out = Object.create(null);
      if (!str) return out;
      for (const part of String(str).split(sep)) {
        if (!part) continue;
        const i = part.indexOf(eq);
        const k = decodeURIComponent((i === -1 ? part : part.slice(0, i)).replace(/\+/g, ' '));
        const v = decodeURIComponent((i === -1 ? '' : part.slice(i + eq.length)).replace(/\+/g, ' '));
        if (out[k] === undefined) out[k] = v;
        else if (Array.isArray(out[k])) out[k].push(v);
        else out[k] = [out[k], v];
      }
      return out;
    },
    stringify(obj, sep = '&', eq = '=') {
      const parts = [];
      for (const [k, v] of Object.entries(obj ?? {})) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          for (const item of v) parts.push(`${encodeURIComponent(k)}${eq}${encodeURIComponent(String(item))}`);
        } else {
          parts.push(`${encodeURIComponent(k)}${eq}${encodeURIComponent(String(v))}`);
        }
      }
      return parts.join(sep);
    },
    escape: encodeURIComponent,
    unescape: decodeURIComponent,
  };
}
