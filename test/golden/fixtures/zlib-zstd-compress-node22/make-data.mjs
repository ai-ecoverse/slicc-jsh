import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import { zstdCompressModule } from '../../../../src/runtime/builtins/zlib-wasm.mjs';

const require = createRequire(import.meta.url);
const { sources, mixed, record } = require('./sources.js');
const C = zlib.constants;
const root = new URL('../../../../', import.meta.url);
const { CCtx } = zstdCompressModule(readFileSync(new URL('src/zstd/compress.wasm', root)));
const dict = readFileSync('dict.bin');

const jshCompress = (input, params = {}, dictionary) => {
  const c = new CCtx();
  if (dictionary) c.loadDictionary(dictionary);
  c.setPledgedSrcSize(2n ** 64n - 1n);
  for (const [k, v] of Object.entries(params)) c.setParameter(+k, +v);
  const parts = [];
  let off = 0;
  for (;;) {
    const out = new Uint8Array(1 << 16);
    if (c.compressStream2(C.ZSTD_e_end, input, off, input.length - off, out, 0, out.length) !== 0) throw new Error('zstd error');
    off = input.length - c.availIn;
    parts.push(out.subarray(0, out.length - c.availOut));
    if (c.availOut !== 0) break;
  }
  c.destroy();
  return Buffer.concat(parts);
};

const big = mixed();
const cases = [
  ['text level 19', sources.text, { [C.ZSTD_c_compressionLevel]: 19 }],
  ['json level -5 checksum', sources.json, { [C.ZSTD_c_compressionLevel]: -5, [C.ZSTD_c_checksumFlag]: 1 }],
  ['binary level 1', sources.binary, { [C.ZSTD_c_compressionLevel]: 1 }],
  ['mixed level 3', big, { [C.ZSTD_c_compressionLevel]: 3 }],
  ['mixed level 12 windowLog 16', big, { [C.ZSTD_c_compressionLevel]: 12, [C.ZSTD_c_windowLog]: 16 }],
  ['mixed level 22', big, { [C.ZSTD_c_compressionLevel]: 22 }],
  ['mixed ldm nbWorkers 2', big, { [C.ZSTD_c_enableLongDistanceMatching]: 1, [C.ZSTD_c_nbWorkers]: 2, [C.ZSTD_c_jobSize]: 1 << 18 }],
  ['record 7 dictionary', record(7), { [C.ZSTD_c_compressionLevel]: 5 }, true],
];
const entries = [];
const node = [];
const jsh = [];
let offset = 0;
for (const [name, source, params, withDict] of cases) {
  const a = zlib.zstdCompressSync(source, { params, ...(withDict ? { dictionary: dict } : {}) });
  const b = jshCompress(source, params, withDict ? dict : undefined);
  if (!a.equals(b)) throw new Error(`${name}: jsh and Node differ`);
  entries.push({ name, offset, length: a.length, params, dict: !!withDict });
  node.push(a);
  jsh.push(b);
  offset += a.length;
}
writeFileSync('cross.json', `${JSON.stringify(entries, null, 1)}\n`);
writeFileSync('node.zst', Buffer.concat(node));
writeFileSync('jsh.zst', Buffer.concat(jsh));
