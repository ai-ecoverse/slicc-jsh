// Writes data.zst, data.json and dict.bin: zstd frames Node 22.22.0's encoder
// made (zstd 1.5.7), for script.js to decode (jsh has no zstd encoder), and
// a dictionary the zstd 1.5.7 CLI trained on sources.js's records. Run it
// with Node 22.22.0 from this directory, the zstd CLI on PATH:
// npx -y node@22.22.0 make-data.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { sources, large, record } from './sources.js';

const C = zlib.constants;
const samples = mkdtempSync(join(tmpdir(), 'zstd-samples-'));
const files = [];
for (let i = 0; i < 300; i++) {
  files.push(join(samples, `${i}.json`));
  writeFileSync(files[i], record(i));
}
execFileSync('zstd', ['-q', '-f', '--train', ...files, '--maxdict=4096', '-o', 'dict.bin']);
rmSync(samples, { recursive: true });
const dict = readFileSync('dict.bin');

const entries = [];
const blobs = [];
let offset = 0;
const push = (name, frame) => {
  entries.push({ name, offset, length: frame.length });
  blobs.push(frame);
  offset += frame.length;
};
const add = (name, source, params, dictionary) =>
  push(name, zlib.zstdCompressSync(source, { params, ...(dictionary ? { dictionary } : {}) }));
// Streamed, the encoder doesn't know the size: the frame keeps its window.
const addStreamed = (name, source, params) =>
  new Promise((resolve) => {
    const parts = [];
    const z = zlib.createZstdCompress({ params });
    z.on('data', (chunk) => parts.push(chunk));
    z.on('end', () => resolve(push(name, Buffer.concat(parts))));
    for (let i = 0; i < source.length; i += 1000) z.write(source.subarray(i, i + 1000));
    z.end();
  });

for (const [name, source] of Object.entries(sources)) {
  if (name === 'medium') continue;
  for (const level of [-5, 1, 3, 9, 19]) {
    for (const windowLog of [10, 17, 23]) {
      add(`${name} l${level} w${windowLog}`, source, {
        [C.ZSTD_c_compressionLevel]: level,
        [C.ZSTD_c_windowLog]: windowLog,
      });
    }
  }
}
add('text l22', sources.text, { [C.ZSTD_c_compressionLevel]: 22 });
add('text checksum', sources.text, { [C.ZSTD_c_checksumFlag]: 1 });
add('text no-size', sources.text, { [C.ZSTD_c_contentSizeFlag]: 0 });
add('medium l1 w17', sources.medium, { [C.ZSTD_c_compressionLevel]: 1, [C.ZSTD_c_windowLog]: 17 });
add('medium l19 w23', sources.medium, { [C.ZSTD_c_compressionLevel]: 19, [C.ZSTD_c_windowLog]: 23 });
add('medium checksum no-size', sources.medium, { [C.ZSTD_c_checksumFlag]: 1, [C.ZSTD_c_contentSizeFlag]: 0 });
await addStreamed('medium streamed w27', sources.medium, { [C.ZSTD_c_windowLog]: 27, [C.ZSTD_c_checksumFlag]: 1 });
await addStreamed('text streamed w28', sources.text, { [C.ZSTD_c_windowLog]: 28 });
add('json raw-dict', sources.json, {}, sources.text);
for (const i of [0, 1, 2]) {
  add(`record ${i} dict l1`, record(i), { [C.ZSTD_c_compressionLevel]: 1 }, dict);
  add(`record ${i} dict l19`, record(i), { [C.ZSTD_c_compressionLevel]: 19, [C.ZSTD_c_checksumFlag]: 1 }, dict);
}
add('record 3 dict no-id', record(3), { [C.ZSTD_c_dictIDFlag]: 0 }, dict);
add('large l3 w23', large(), { [C.ZSTD_c_compressionLevel]: 3, [C.ZSTD_c_windowLog]: 23, [C.ZSTD_c_checksumFlag]: 1 });
writeFileSync('data.zst', Buffer.concat(blobs));
writeFileSync('data.json', `${JSON.stringify(entries, null, 1)}\n`);
