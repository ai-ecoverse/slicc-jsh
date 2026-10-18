// Writes data.br and data.json: Brotli streams Node 22.22.0's encoder made,
// for script.js to decode (jsh has no Brotli encoder). Run it with Node
// 22.22.0 from this directory: npx -y node@22.22.0 make-data.mjs
import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { sources, large } from './sources.js';

const C = zlib.constants;
const entries = [];
const blobs = [];
let offset = 0;
const add = (name, source, params) => {
  const br = zlib.brotliCompressSync(source, { params });
  entries.push({ name, offset, length: br.length });
  blobs.push(br);
  offset += br.length;
};
for (const [name, source] of Object.entries(sources)) {
  for (const quality of [0, 1, 5, 9, 11]) {
    for (const lgwin of [10, 16, 24]) {
      add(`${name} q${quality} w${lgwin}`, source, { [C.BROTLI_PARAM_QUALITY]: quality, [C.BROTLI_PARAM_LGWIN]: lgwin });
    }
  }
}
add('text text-mode q11', sources.text, { [C.BROTLI_PARAM_MODE]: C.BROTLI_MODE_TEXT });
add('text large-window w26', sources.text, {
  [C.BROTLI_PARAM_LARGE_WINDOW]: 1,
  [C.BROTLI_PARAM_LGWIN]: 26,
});
add('large q5 w22', large(), { [C.BROTLI_PARAM_QUALITY]: 5, [C.BROTLI_PARAM_LGWIN]: 22 });
writeFileSync('data.br', Buffer.concat(blobs));
writeFileSync('data.json', `${JSON.stringify(entries, null, 1)}\n`);
