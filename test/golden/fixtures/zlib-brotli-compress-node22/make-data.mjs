import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import { brotliEncoderModule } from '../../../../src/runtime/builtins/zlib-wasm.mjs';

const require = createRequire(import.meta.url);
const { sources, mixed } = require('./sources.js');
const C = zlib.constants;
const root = new URL('../../../../', import.meta.url);
const dictionary = zlib.brotliDecompressSync(readFileSync(new URL('src/brotli/dictionary.bin.br', root)));
const { BrotliEncoder } = brotliEncoderModule(readFileSync(new URL('src/brotli/encoder.wasm', root)), dictionary);

const jshCompress = (input, params = {}) => {
  const enc = new BrotliEncoder();
  for (const [k, v] of Object.entries(params)) enc.setParameter(+k, +v);
  const parts = [];
  let off = 0;
  for (;;) {
    const out = new Uint8Array(1 << 16);
    enc.compressStream(C.BROTLI_OPERATION_FINISH, input, off, input.length - off, out, 0, out.length);
    off = input.length - enc.availIn;
    parts.push(out.subarray(0, out.length - enc.availOut));
    if (enc.availOut !== 0) break;
  }
  enc.destroy();
  return Buffer.concat(parts);
};

const big = mixed();
const cases = [
  ['text q11', sources.text, { [C.BROTLI_PARAM_QUALITY]: 11 }],
  ['json q5 font', sources.json, { [C.BROTLI_PARAM_QUALITY]: 5, [C.BROTLI_PARAM_MODE]: C.BROTLI_MODE_FONT }],
  ['binary q1', sources.binary, { [C.BROTLI_PARAM_QUALITY]: 1 }],
  ['mixed q0', big, { [C.BROTLI_PARAM_QUALITY]: 0 }],
  ['mixed q7 lgwin 16', big, { [C.BROTLI_PARAM_QUALITY]: 7, [C.BROTLI_PARAM_LGWIN]: 16 }],
  ['mixed q9 lgwin 26 large', big, { [C.BROTLI_PARAM_QUALITY]: 9, [C.BROTLI_PARAM_LGWIN]: 26, [C.BROTLI_PARAM_LARGE_WINDOW]: 1 }, true],
  ['utf8 default', sources.utf8, undefined],
];
const entries = [];
const node = [];
const jsh = [];
let offset = 0;
for (const [name, source, params, large] of cases) {
  const a = zlib.brotliCompressSync(source, params ? { params } : undefined);
  const b = jshCompress(source, params);
  if (!a.equals(b)) throw new Error(`${name}: jsh and Node differ`);
  entries.push({ name, offset, length: a.length, params, large: !!large });
  node.push(a);
  jsh.push(b);
  offset += a.length;
}
writeFileSync('cross.json', `${JSON.stringify(entries, null, 1)}\n`);
writeFileSync('node.br', Buffer.concat(node));
writeFileSync('jsh.br', Buffer.concat(jsh));
