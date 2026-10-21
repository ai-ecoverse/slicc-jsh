const zlib = require('zlib');
const fs = require('fs');
const { promisify } = require('util');
const { pipeline, Readable, Writable } = require('stream');
const { sources, mixed } = require('./sources.js');

const C = zlib.constants;
const P = (params) => ({ params });
const big = mixed();
const cross = JSON.parse(fs.readFileSync(`${__dirname}/cross.json`, 'utf8'));
const blob = (file) => fs.readFileSync(`${__dirname}/${file}`);
const node = blob('node.br');
const jsh = blob('jsh.br');

const describe = (v) => {
  if (Buffer.isBuffer(v)) return `<${v.length}> crc ${zlib.crc32(v)}`;
  if (v && Buffer.isBuffer(v.buffer)) return `info <${v.buffer.length}> crc ${zlib.crc32(v.buffer)} engine ${v.engine.constructor.name} bytesWritten ${v.engine.bytesWritten}`;
  return v === undefined ? 'undefined' : JSON.stringify(v);
};
const error = (e) => `${e.name} ${e.code} ${e.errno} ${JSON.stringify(e.message)}`;
const show = (label, f) => {
  let v;
  try {
    v = describe(f());
  } catch (e) {
    v = `THROW ${error(e)}`;
  }
  console.log(`${label}: ${v}`);
};
const roundTrip = (source, opts) => {
  const packed = zlib.brotliCompressSync(source, opts);
  const back = zlib.brotliDecompressSync(packed, opts?.params?.[C.BROTLI_PARAM_LARGE_WINDOW] ? P({ [C.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 1 }) : undefined);
  return `${describe(packed)} ${back.equals(source) ? 'round trip ok' : 'ROUND TRIP MISMATCH'}`;
};
const queue = [];
const later = (label, f) => queue.push([label, f]);

show('process.versions.brotli', () => process.versions.brotli);
show('typeof', () => [typeof zlib.BrotliCompress, typeof zlib.brotliCompress, typeof zlib.brotliCompressSync, typeof zlib.createBrotliCompress].join(' '));
show('instanceof', () => [zlib.createBrotliCompress() instanceof zlib.BrotliCompress, zlib.BrotliCompress() instanceof zlib.BrotliCompress, new zlib.BrotliCompress().constructor.name].join(' '));
show('createBrotliCompress name', () => zlib.createBrotliCompress.name);
show('tiny hex', () => zlib.brotliCompressSync('x').toString('hex'));
show('empty hex', () => zlib.brotliCompressSync('').toString('hex'));

for (const [name, source] of Object.entries(sources)) {
  for (let q = 0; q <= 11; q++) show(`${name} q${q}`, () => roundTrip(source, P({ [C.BROTLI_PARAM_QUALITY]: q })));
  show(`${name} default`, () => roundTrip(source));
}
for (const q of [0, 1, 2, 4, 5, 9, 10]) show(`mixed 1 MB q${q}`, () => roundTrip(big, P({ [C.BROTLI_PARAM_QUALITY]: q })));
show('mixed 1 MB default', () => roundTrip(big));
for (const lgwin of [10, 12, 16, 18, 22, 24]) {
  for (const q of [1, 5, 11]) show(`text lgwin ${lgwin} q${q}`, () => roundTrip(sources.text, P({ [C.BROTLI_PARAM_QUALITY]: q, [C.BROTLI_PARAM_LGWIN]: lgwin })));
}
for (const lgwin of [25, 26, 30]) show(`mixed lgwin ${lgwin} large window`, () => roundTrip(big, P({ [C.BROTLI_PARAM_QUALITY]: 4, [C.BROTLI_PARAM_LGWIN]: lgwin, [C.BROTLI_PARAM_LARGE_WINDOW]: true })));
show('lgwin 30 without large window', () => roundTrip(sources.text, P({ [C.BROTLI_PARAM_LGWIN]: 30 })));
for (const mode of [C.BROTLI_MODE_GENERIC, C.BROTLI_MODE_TEXT, C.BROTLI_MODE_FONT, 7]) {
  for (const q of [2, 6, 11]) show(`json mode ${mode} q${q}`, () => roundTrip(sources.json, P({ [C.BROTLI_PARAM_MODE]: mode, [C.BROTLI_PARAM_QUALITY]: q })));
}
for (const lgblock of [0, 16, 20, 24, 30]) show(`text lgblock ${lgblock}`, () => roundTrip(sources.text, P({ [C.BROTLI_PARAM_LGBLOCK]: lgblock, [C.BROTLI_PARAM_QUALITY]: 7 })));
show('text no literal context modeling', () => roundTrip(sources.text, P({ [C.BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING]: true, [C.BROTLI_PARAM_QUALITY]: 9 })));
show('text size hint', () => roundTrip(sources.text, P({ [C.BROTLI_PARAM_SIZE_HINT]: sources.text.length })));
show('text size hint q5', () => roundTrip(sources.text, P({ [C.BROTLI_PARAM_SIZE_HINT]: sources.text.length, [C.BROTLI_PARAM_QUALITY]: 5 })));
for (const [npostfix, ndirect] of [[1, 0], [2, 12], [3, 120], [0, 15], [4, 0]]) {
  show(`json npostfix ${npostfix} ndirect ${ndirect}`, () => roundTrip(sources.json, P({ [C.BROTLI_PARAM_NPOSTFIX]: npostfix, [C.BROTLI_PARAM_NDIRECT]: ndirect, [C.BROTLI_PARAM_QUALITY]: 11 })));
}
for (const q of [-1, 12, 100, 2 ** 32 - 2]) show(`quality ${q}`, () => roundTrip(sources.utf8, P({ [C.BROTLI_PARAM_QUALITY]: q })));
show('quality true', () => roundTrip(sources.utf8, P({ [C.BROTLI_PARAM_QUALITY]: true })));
show('quality 4.7', () => roundTrip(sources.utf8, P({ [C.BROTLI_PARAM_QUALITY]: 4.7 })));
show('quality NaN', () => roundTrip(sources.utf8, P({ [C.BROTLI_PARAM_QUALITY]: NaN })));
show('param 6', () => roundTrip(sources.utf8, P({ 6: 5 })));
show('param 3', () => roundTrip(sources.utf8, P({ 3: 5 })));
show('param 9', () => zlib.brotliCompressSync('x', P({ 9: 5 })));
show('param -1', () => zlib.brotliCompressSync('x', P({ '-1': 5 })));
show('param x', () => zlib.brotliCompressSync('x', P({ x: 5 })));
show('param string', () => zlib.brotliCompressSync('x', P({ [C.BROTLI_PARAM_QUALITY]: '5' })));
show('param null', () => zlib.brotliCompressSync('x', P({ [C.BROTLI_PARAM_QUALITY]: null })));
show('params array', () => roundTrip(sources.utf8, P([1, 5])));

show('string input', () => zlib.brotliCompressSync('héllo wörld'));
show('Uint16Array input', () => zlib.brotliCompressSync(new Uint16Array([1, 2, 3, 65535])));
show('DataView input', () => zlib.brotliCompressSync(new DataView(sources.text.buffer, sources.text.byteOffset, 100)));
show('ArrayBuffer input', () => zlib.brotliCompressSync(new Uint8Array([1, 2, 3]).buffer));
show('number input', () => zlib.brotliCompressSync(5));
show('object input', () => zlib.brotliCompressSync({}));
show('info', () => zlib.brotliCompressSync(sources.json, { info: true }));
show('maxOutputLength 10', () => zlib.brotliCompressSync(sources.binary, { maxOutputLength: 10 }));
show('maxOutputLength 0', () => zlib.brotliCompressSync(sources.binary, { maxOutputLength: 0 }));
show('chunkSize 64', () => roundTrip(sources.text, { chunkSize: 64 }));
show('chunkSize 63', () => zlib.brotliCompressSync('x', { chunkSize: 63 }));
show('finishFlush FLUSH', () => zlib.brotliCompressSync(sources.utf8, { finishFlush: C.BROTLI_OPERATION_FLUSH }));
show('finishFlush PROCESS', () => zlib.brotliCompressSync(sources.utf8, { finishFlush: C.BROTLI_OPERATION_PROCESS }));
show('finishFlush EMIT_METADATA', () => zlib.brotliCompressSync(sources.utf8, { finishFlush: C.BROTLI_OPERATION_EMIT_METADATA }));
show('finishFlush 4', () => zlib.brotliCompressSync(sources.utf8, { finishFlush: 4 }));
show('flush 4', () => zlib.brotliCompressSync(sources.utf8, { flush: 4 }));
show('options null', () => zlib.brotliCompressSync('abc', null));
show('objectMode ignored', () => zlib.brotliCompressSync('abc', { objectMode: true, encoding: 'hex' }));

for (const e of cross) {
  show(`node-made ${e.name}`, () => {
    const packed = node.subarray(e.offset, e.offset + e.length);
    const back = zlib.brotliDecompressSync(packed, e.large ? P({ [C.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 1 }) : undefined);
    const again = zlib.brotliCompressSync(back, e.params ? P(e.params) : undefined);
    return `${describe(back)} recompressed ${again.equals(packed) ? 'same' : 'DIFFERENT'}`;
  });
  show(`jsh-made ${e.name}`, () => {
    const packed = jsh.subarray(e.offset, e.offset + e.length);
    return describe(zlib.brotliDecompressSync(packed, e.large ? P({ [C.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 1 }) : undefined));
  });
}

const collect = (stream, label, done) => {
  const sizes = [];
  const parts = [];
  stream.on('data', (chunk) => {
    sizes.push(chunk.length);
    parts.push(chunk);
  });
  stream.on('error', (e) => {
    console.log(`${label}: error ${error(e)}`);
    done();
  });
  stream.on('end', () => {
    const out = Buffer.concat(parts);
    const runs = [];
    for (const size of sizes) {
      const last = runs[runs.length - 1];
      if (last && last[0] === size) last[1]++;
      else runs.push([size, 1]);
    }
    const chunks = runs.map(([size, n]) => (n > 1 ? `${size}x${n}` : `${size}`)).join(',');
    console.log(`${label}: chunks ${chunks} ${describe(out)} bytesWritten ${stream.bytesWritten}`);
    done(out);
  });
};

later('callback', (done) => zlib.brotliCompress(sources.text, (err, out) => { console.log('callback:', err, describe(out)); done(); }));
later('callback with options', (done) => zlib.brotliCompress(sources.text, P({ [C.BROTLI_PARAM_QUALITY]: 3 }), (err, out) => { console.log('callback with options:', err, describe(out)); done(); }));
later('callback info', (done) => zlib.brotliCompress(sources.json, { info: true }, (err, out) => { console.log('callback info:', err, describe(out)); done(); }));
later('callback maxOutputLength', (done) => zlib.brotliCompress(sources.binary, { maxOutputLength: 100 }, (err, out) => { console.log('callback maxOutputLength:', error(err), out); done(); }));
later('callback 1 MB', (done) => zlib.brotliCompress(big, P({ [C.BROTLI_PARAM_QUALITY]: 6 }), (err, out) => { console.log('callback 1 MB:', err, describe(out), zlib.brotliDecompressSync(out).equals(big)); done(); }));
later('callback without callback', (done) => { show('callback without callback', () => zlib.brotliCompress('x')); done(); });
later('callback bad input', (done) => { show('callback bad input', () => zlib.brotliCompress(5, () => {})); done(); });
later('promisify', (done) => promisify(zlib.brotliCompress)(sources.utf8).then((out) => { console.log('promisify:', describe(out)); done(); }));
later('stream default', (done) => {
  const s = zlib.createBrotliCompress();
  collect(s, 'stream default', done);
  s.end(sources.text);
});
later('stream 1-byte writes', (done) => {
  const s = zlib.createBrotliCompress(P({ [C.BROTLI_PARAM_QUALITY]: 5 }));
  collect(s, 'stream 1-byte writes', done);
  for (const b of sources.utf8.subarray(0, 300)) s.write(Buffer.from([b]));
  s.end();
});
later('stream 1000-byte writes chunkSize 1024', (done) => {
  const s = zlib.createBrotliCompress({ chunkSize: 1024, params: { [C.BROTLI_PARAM_QUALITY]: 9 } });
  collect(s, 'stream 1000-byte writes chunkSize 1024', done);
  for (let i = 0; i < big.length; i += 1000) s.write(big.subarray(i, i + 1000));
  s.end();
});
later('stream flush', (done) => {
  const s = zlib.createBrotliCompress();
  const events = [];
  s.on('data', (c) => events.push(`data ${c.length}`));
  s.write(sources.text.subarray(0, 5000));
  s.flush(() => {
    events.push('flushed');
    s.write(sources.text.subarray(5000, 9000));
    s.flush(C.BROTLI_OPERATION_EMIT_METADATA, () => {
      events.push('metadata');
      s.end(sources.text.subarray(9000, 12000));
    });
  });
  s.on('end', () => {
    console.log('stream flush:', events.join(', '));
    done();
  });
});
later('stream flush after end', (done) => {
  const s = zlib.createBrotliCompress();
  s.resume();
  s.end('abc');
  s.flush(() => {
    console.log('stream flush after end: callback');
    done();
  });
});
later('stream params', (done) => {
  const s = zlib.createBrotliCompress();
  s.params(1, 0, () => console.log('stream params: callback'));
  collect(s, 'stream params', done);
  s.end(sources.json);
});
later('stream reset', (done) => {
  const s = zlib.createBrotliCompress(P({ [C.BROTLI_PARAM_QUALITY]: 2 }));
  const parts = [];
  s.on('data', (c) => parts.push(c));
  s.write(sources.text.subarray(0, 3000), () => {
    s.reset();
    s.end(sources.utf8);
  });
  s.on('end', () => {
    const out = Buffer.concat(parts);
    console.log('stream reset:', describe(out));
    done();
  });
});
later('stream close', (done) => {
  const s = zlib.createBrotliCompress();
  s.write('abc');
  s.close(() => {
    console.log('stream close:', s.destroyed, s._closed);
    show('stream reset after close', () => s.reset());
    done();
  });
});
later('stream write after end', (done) => {
  const s = zlib.createBrotliCompress();
  s.resume();
  s.end('abc');
  s.on('error', (e) => {
    console.log('stream write after end:', error(e));
    done();
  });
  s.write('more');
});
later('pipeline', (done) => {
  const parts = [];
  pipeline(
    Readable.from([sources.text.subarray(0, 20000), sources.text.subarray(20000)]),
    zlib.createBrotliCompress(P({ [C.BROTLI_PARAM_QUALITY]: 4 })),
    zlib.createBrotliDecompress(),
    new Writable({ write(c, e, cb) { parts.push(c); cb(); } }),
    (err) => {
      console.log('pipeline:', err, Buffer.concat(parts).equals(sources.text));
      done();
    }
  );
});
later('stream info and bytesWritten', (done) => {
  const s = zlib.createBrotliCompress();
  s.resume();
  s.write(sources.json.subarray(0, 1000));
  s.end(sources.json.subarray(1000, 3000), () => {
    console.log('stream info and bytesWritten:', s.bytesWritten);
    done();
  });
});

const next = () => {
  const item = queue.shift();
  if (!item) return;
  item[1](() => setImmediate(next));
};
next();
