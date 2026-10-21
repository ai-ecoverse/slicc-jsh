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

function json(seed, n) {
  const rnd = lcg(seed);
  const pick = () => words[(rnd() * words.length) | 0];
  return Buffer.from(
    JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i, name: `${pick()}-${i}`, score: (rnd() * 1e6) | 0, tags: [pick(), pick()], ok: rnd() < 0.5 })), null, 1)
  );
}

const sources = {
  empty: Buffer.alloc(0),
  tiny: Buffer.from('x'),
  text: Buffer.from(prose(1, 9000)),
  json: json(5, 400),
  utf8: Buffer.from('Grüße aus Köln, naïve café, 東京 und Ελλάδα: THE WORLD, The World, the world. '.repeat(40)),
  binary: bytes(2, 20000),
};

function mixed() {
  const parts = [];
  let size = 0;
  for (let i = 0; size < 1 << 20; i++) {
    const part = [Buffer.from(prose(10 + i, 3000)), json(20 + i, 120), bytes(30 + i, 4000)][i % 3];
    parts.push(part);
    size += part.length;
  }
  return Buffer.concat(parts).subarray(0, 1 << 20);
}

module.exports = { sources, mixed, prose, bytes };
