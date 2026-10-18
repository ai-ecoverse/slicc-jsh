// The payloads behind data.br, generated (so data.br stays small): script.js
// compares what it decodes with them.
const words =
  'the of and to in is that for it as was with be by on not he this are or his from at which but have an they you were her she there would their we him been has when who will more no if out so said what up its about into than them can only other new some could time these two may then do first any my now such like our over man me even most made after also did many before must through back years where much your way well down should because each just those people how too little state good very make world still own see men work long get here between both life being under never day same another know while last might us great old year off come since against go came right used take three'.split(' ');

function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
}

function prose(seed, n) {
  const rnd = lcg(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    let w = words[(rnd() * words.length) | 0];
    if (i % 12 === 0) w = w[0].toUpperCase() + w.slice(1);
    out.push(w);
    if (i % 12 === 11) out.push('.\n');
  }
  return out.join(' ');
}

function bytes(seed, n) {
  const rnd = lcg(seed);
  return Buffer.from(Array.from({ length: n }, () => (rnd() * 256) | 0));
}

const sources = {
  text: Buffer.from(prose(1, 700)),
  json: Buffer.from(
    JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: i, name: words[i * 7 % words.length], tags: [words[i % 9], words[(i * 3) % 11]], ok: i % 3 === 0 })))
  ),
  utf8: Buffer.from('Grüße aus Köln, naïve café, 東京 und Ελλάδα: THE WORLD, The World, the world. '.repeat(15)),
  binary: bytes(2, 800),
  tiny: Buffer.from('a'),
  empty: Buffer.alloc(0),
};

/** About 20 MB: one 64 KB block of prose, 320 times, each copy numbered. */
function large() {
  const block = prose(3, 11000).slice(0, 65536);
  const parts = [];
  for (let i = 0; i < 320; i++) parts.push(`--- ${i} ---\n`, block);
  return Buffer.from(parts.join(''));
}

module.exports = { sources, large };
