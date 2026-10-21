const zlib = require('zlib');
const fs = require('fs');
const { promisify } = require('util');
const { pipeline, Readable, Writable } = require('stream');
const { sources, mixed, record } = require('./sources.js');

const C = zlib.constants;
const P = (params) => ({ params });
const big = mixed();
const dict = fs.readFileSync(`${__dirname}/dict.bin`);
const cross = JSON.parse(fs.readFileSync(`${__dirname}/cross.json`, 'utf8'));
const node = fs.readFileSync(`${__dirname}/node.zst`);
const jsh = fs.readFileSync(`${__dirname}/jsh.zst`);

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
const decodeOpts = (opts) => {
  const d = {};
  if (opts?.dictionary) d.dictionary = opts.dictionary;
  const windowLog = opts?.params?.[C.ZSTD_c_windowLog];
  if (windowLog > 27) d.params = { [C.ZSTD_d_windowLogMax]: windowLog };
  return d;
};
const roundTrip = (source, opts) => {
  const packed = zlib.zstdCompressSync(source, opts);
  const back = zlib.zstdDecompressSync(packed, decodeOpts(opts));
  return `${describe(packed)} ${back.equals(source) ? 'round trip ok' : 'ROUND TRIP MISMATCH'}`;
};
const queue = [];
const later = (label, f) => queue.push([label, f]);
const level = (l) => P({ [C.ZSTD_c_compressionLevel]: l });

show('process.versions.zstd', () => process.versions.zstd);
show('typeof', () => [typeof zlib.ZstdCompress, typeof zlib.zstdCompress, typeof zlib.zstdCompressSync, typeof zlib.createZstdCompress].join(' '));
show('instanceof', () => [zlib.createZstdCompress() instanceof zlib.ZstdCompress, new zlib.ZstdCompress().constructor.name, typeof zlib.createZstdCompress().params].join(' '));
show('ZstdCompress without new', () => zlib.ZstdCompress());
show('createZstdCompress name', () => zlib.createZstdCompress.name);
show('tiny hex', () => zlib.zstdCompressSync('x').toString('hex'));
show('empty hex', () => zlib.zstdCompressSync('').toString('hex'));
show('garbage', () => zlib.zstdDecompressSync(Buffer.from('garbage in, garbage out')));

const levels = [-131072, -5, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 15, 16, 17, 19, 20, 22, 23];
for (const [name, source] of Object.entries(sources)) {
  for (const l of levels) show(`${name} level ${l}`, () => roundTrip(source, level(l)));
  show(`${name} default`, () => roundTrip(source));
}
for (const l of [-5, 1, 3, 6, 9, 15, 19]) show(`mixed 1 MB level ${l}`, () => roundTrip(big, level(l)));
show('mixed 1 MB default', () => roundTrip(big));
for (const windowLog of [10, 12, 16, 20, 24, 27, 28, 30]) {
  for (const l of [1, 9, 19]) show(`mixed windowLog ${windowLog} level ${l}`, () => roundTrip(big, P({ [C.ZSTD_c_compressionLevel]: l, [C.ZSTD_c_windowLog]: windowLog })));
}
for (let strategy = 1; strategy <= 9; strategy++) show(`json strategy ${strategy}`, () => roundTrip(sources.json, P({ [C.ZSTD_c_strategy]: strategy })));
show('text hashLog 6', () => roundTrip(sources.text, P({ [C.ZSTD_c_hashLog]: 6 })));
show('text hashLog 24', () => roundTrip(sources.text, P({ [C.ZSTD_c_hashLog]: 24, [C.ZSTD_c_compressionLevel]: 9 })));
show('text chainLog 6 strategy 5', () => roundTrip(sources.text, P({ [C.ZSTD_c_chainLog]: 6, [C.ZSTD_c_strategy]: 5 })));
show('text searchLog 9 strategy 6', () => roundTrip(sources.text, P({ [C.ZSTD_c_searchLog]: 9, [C.ZSTD_c_strategy]: 6 })));
show('text minMatch 7', () => roundTrip(sources.text, P({ [C.ZSTD_c_minMatch]: 7 })));
show('text targetLength 999 strategy 9', () => roundTrip(sources.text, P({ [C.ZSTD_c_targetLength]: 999, [C.ZSTD_c_strategy]: 9 })));
show('mixed long distance matching', () => roundTrip(big, P({ [C.ZSTD_c_enableLongDistanceMatching]: 1 })));
show('mixed ldm params', () => roundTrip(big, P({ [C.ZSTD_c_enableLongDistanceMatching]: 1, [C.ZSTD_c_ldmHashLog]: 20, [C.ZSTD_c_ldmMinMatch]: 32, [C.ZSTD_c_ldmBucketSizeLog]: 4, [C.ZSTD_c_ldmHashRateLog]: 6 })));
show('text no content size', () => roundTrip(sources.text, P({ [C.ZSTD_c_contentSizeFlag]: 0 })));
show('text checksum', () => roundTrip(sources.text, P({ [C.ZSTD_c_checksumFlag]: 1 })));
show('text checksum true', () => roundTrip(sources.text, P({ [C.ZSTD_c_checksumFlag]: true })));
for (const workers of [1, 2, 4]) {
  show(`mixed nbWorkers ${workers}`, () => roundTrip(big, P({ [C.ZSTD_c_nbWorkers]: workers })));
  show(`mixed nbWorkers ${workers} jobSize 1 MB overlapLog 3`, () => roundTrip(big, P({ [C.ZSTD_c_nbWorkers]: workers, [C.ZSTD_c_jobSize]: 1 << 20, [C.ZSTD_c_overlapLog]: 3 })));
  show(`mixed nbWorkers ${workers} level 9 ldm`, () => roundTrip(big, P({ [C.ZSTD_c_nbWorkers]: workers, [C.ZSTD_c_compressionLevel]: 9, [C.ZSTD_c_enableLongDistanceMatching]: 1 })));
}
show('level 4.7', () => roundTrip(sources.utf8, level(4.7)));
show('level NaN', () => roundTrip(sources.utf8, level(NaN)));
show('level true', () => roundTrip(sources.utf8, level(true)));
show('windowLog 40', () => zlib.zstdCompressSync('x', P({ [C.ZSTD_c_windowLog]: 40 })));
show('windowLog 9', () => zlib.zstdCompressSync('x', P({ [C.ZSTD_c_windowLog]: 9 })));
show('strategy 10', () => zlib.zstdCompressSync('x', P({ [C.ZSTD_c_strategy]: 10 })));
show('param 99', () => zlib.zstdCompressSync('x', P({ 99: 1 })));
show('param 1000', () => zlib.zstdCompressSync('x', P({ 1000: 1 })));
show('param 1001', () => zlib.zstdCompressSync('x', P({ 1001: 1 })));
show('param x', () => zlib.zstdCompressSync('x', P({ x: 1 })));
show('param string', () => zlib.zstdCompressSync('x', level('5')));
show('param decompression key', () => zlib.zstdCompressSync('x', P({ [C.ZSTD_d_windowLogMax]: 20 })));

show('pledgedSrcSize exact', () => roundTrip(sources.json, { pledgedSrcSize: sources.json.length }));
show('pledgedSrcSize wrong, sync', () => roundTrip(sources.json, { pledgedSrcSize: 5 }));
show('pledgedSrcSize -1', () => zlib.zstdCompressSync('x', { pledgedSrcSize: -1 }));
show('pledgedSrcSize -0.5', () => zlib.zstdCompressSync('x', { pledgedSrcSize: -0.5 }));
show('pledgedSrcSize NaN', () => zlib.zstdCompressSync('x', { pledgedSrcSize: NaN }));
show('pledgedSrcSize Infinity', () => zlib.zstdCompressSync('x', { pledgedSrcSize: Infinity }));
show('pledgedSrcSize -Infinity', () => zlib.zstdCompressSync('x', { pledgedSrcSize: -Infinity }));
show('pledgedSrcSize 1.9', () => zlib.zstdCompressSync('x', { pledgedSrcSize: 1.9 }));
show('pledgedSrcSize string', () => zlib.zstdCompressSync('x', { pledgedSrcSize: '1' }));
show('pledgedSrcSize null', () => zlib.zstdCompressSync('x', { pledgedSrcSize: null }));
show('pledgedSrcSize 2**60', () => zlib.zstdCompressSync('x', { pledgedSrcSize: 2 ** 60 }));

for (let i = 0; i < 4; i++) {
  show(`record ${i} trained dictionary`, () => roundTrip(record(i), { dictionary: dict }));
  show(`record ${i} trained dictionary level 19`, () => roundTrip(record(i), { dictionary: dict, ...level(19) }));
  show(`record ${i} trained dictionary no id`, () => roundTrip(record(i), { dictionary: dict, params: { [C.ZSTD_c_dictIDFlag]: 0 } }));
}
show('text raw dictionary', () => roundTrip(sources.text, { dictionary: sources.text.subarray(0, 20000) }));
show('json raw dictionary Uint16Array', () => roundTrip(sources.json, { dictionary: new Uint16Array(sources.json.buffer, sources.json.byteOffset, 1000) }));
show('dictionary ArrayBuffer is ignored', () => zlib.zstdCompressSync(record(0), { dictionary: dict.buffer.slice(dict.byteOffset, dict.byteOffset + dict.length) }));
show('dictionary string is ignored', () => zlib.zstdCompressSync(record(0), { dictionary: 'abc' }));
show('dictionary empty', () => zlib.zstdCompressSync(record(0), { dictionary: Buffer.alloc(0) }));
show('dictionary corrupt', () => zlib.zstdCompressSync(record(0), { dictionary: Buffer.concat([dict.subarray(0, 8), Buffer.alloc(200, 7)]) }));
show('dictionary frame with the dictionary', () => zlib.zstdDecompressSync(zlib.zstdCompressSync(record(5), { dictionary: dict }), { dictionary: dict }).equals(record(5)));
show('dictionary frame without it', () => zlib.zstdDecompressSync(zlib.zstdCompressSync(record(5), { dictionary: dict })));

show('string input', () => zlib.zstdCompressSync('héllo wörld'));
show('Uint16Array input', () => zlib.zstdCompressSync(new Uint16Array([1, 2, 3, 65535])));
show('DataView input', () => zlib.zstdCompressSync(new DataView(sources.text.buffer, sources.text.byteOffset, 100)));
show('ArrayBuffer input', () => zlib.zstdCompressSync(new Uint8Array([1, 2, 3]).buffer));
show('number input', () => zlib.zstdCompressSync(5));
show('info', () => zlib.zstdCompressSync(sources.json, { info: true }));
show('maxOutputLength 10', () => zlib.zstdCompressSync(sources.binary, { maxOutputLength: 10 }));
show('chunkSize 64', () => roundTrip(sources.text, { chunkSize: 64 }));
show('finishFlush e_flush', () => zlib.zstdCompressSync(sources.utf8, { finishFlush: C.ZSTD_e_flush }));
show('finishFlush e_continue', () => zlib.zstdCompressSync(sources.utf8, { finishFlush: C.ZSTD_e_continue }));
show('finishFlush 3', () => zlib.zstdCompressSync(sources.utf8, { finishFlush: 3 }));
show('flush e_flush', () => zlib.zstdCompressSync(sources.utf8, { flush: C.ZSTD_e_flush }));
show('options null', () => zlib.zstdCompressSync('abc', null));

for (const e of cross) {
  const d = e.dict ? { dictionary: dict } : {};
  show(`node-made ${e.name}`, () => {
    const packed = node.subarray(e.offset, e.offset + e.length);
    const back = zlib.zstdDecompressSync(packed, d);
    const again = zlib.zstdCompressSync(back, { ...d, params: e.params });
    return `${describe(back)} recompressed ${again.equals(packed) ? 'same' : 'DIFFERENT'}`;
  });
  show(`jsh-made ${e.name}`, () => describe(zlib.zstdDecompressSync(jsh.subarray(e.offset, e.offset + e.length), d)));
}

const runs = (sizes) => {
  const out = [];
  for (const size of sizes) {
    const last = out[out.length - 1];
    if (last && last[0] === size) last[1]++;
    else out.push([size, 1]);
  }
  return out.map(([size, n]) => (n > 1 ? `${size}x${n}` : `${size}`)).join(',');
};
const collect = (stream, label, done, sizes = true) => {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  stream.on('error', (e) => {
    console.log(`${label}: error ${error(e)}`);
    done();
  });
  stream.on('end', () => {
    const out = Buffer.concat(chunks);
    console.log(`${label}: ${sizes ? `chunks ${runs(chunks.map((c) => c.length))} ` : ''}${describe(out)} bytesWritten ${stream.bytesWritten}`);
    done(out);
  });
};

later('callback', (done) => zlib.zstdCompress(sources.text, (err, out) => { console.log('callback:', err, describe(out)); done(); }));
later('callback with options', (done) => zlib.zstdCompress(sources.text, level(12), (err, out) => { console.log('callback with options:', err, describe(out)); done(); }));
later('callback info', (done) => zlib.zstdCompress(sources.json, { info: true }, (err, out) => { console.log('callback info:', err, describe(out)); done(); }));
later('callback maxOutputLength', (done) => zlib.zstdCompress(sources.binary, { maxOutputLength: 100 }, (err, out) => { console.log('callback maxOutputLength:', error(err), out); done(); }));
later('callback 1 MB', (done) => zlib.zstdCompress(big, level(7), (err, out) => { console.log('callback 1 MB:', err, describe(out), zlib.zstdDecompressSync(out).equals(big)); done(); }));
later('callback bad params', (done) => { show('callback bad params', () => zlib.zstdCompress('x', P({ 1000: 1 }), () => {})); done(); });
later('promisify', (done) => promisify(zlib.zstdCompress)(sources.utf8).then((out) => { console.log('promisify:', describe(out)); done(); }));
later('stream default', (done) => {
  const s = zlib.createZstdCompress();
  collect(s, 'stream default', done);
  s.end(sources.text);
});
later('stream 1-byte writes', (done) => {
  const s = zlib.createZstdCompress(level(5));
  collect(s, 'stream 1-byte writes', done);
  for (const b of sources.utf8.subarray(0, 300)) s.write(Buffer.from([b]));
  s.end();
});
later('stream 1000-byte writes chunkSize 1024', (done) => {
  const s = zlib.createZstdCompress({ chunkSize: 1024, params: { [C.ZSTD_c_compressionLevel]: 9, [C.ZSTD_c_checksumFlag]: 1 } });
  collect(s, 'stream 1000-byte writes chunkSize 1024', done);
  for (let i = 0; i < big.length; i += 1000) s.write(big.subarray(i, i + 1000));
  s.end();
});
later('stream pledgedSrcSize exact', (done) => {
  const s = zlib.createZstdCompress({ pledgedSrcSize: 3000 });
  collect(s, 'stream pledgedSrcSize exact', done);
  s.write(sources.text.subarray(0, 1000));
  s.end(sources.text.subarray(1000, 3000));
});
later('stream pledgedSrcSize too small', (done) => {
  const s = zlib.createZstdCompress({ pledgedSrcSize: 100 });
  collect(s, 'stream pledgedSrcSize too small', done);
  s.write(sources.text.subarray(0, 1000));
  s.end(sources.text.subarray(1000, 3000));
});
later('stream pledgedSrcSize too large', (done) => {
  const s = zlib.createZstdCompress({ pledgedSrcSize: 5000 });
  collect(s, 'stream pledgedSrcSize too large', done);
  s.write(sources.text.subarray(0, 1000));
  s.end(sources.text.subarray(1000, 3000));
});
later('stream flush', (done) => {
  const s = zlib.createZstdCompress();
  const events = [];
  s.on('data', (c) => events.push(`data ${c.length}`));
  s.write(sources.text.subarray(0, 5000));
  s.flush(() => {
    events.push('flushed');
    s.write(sources.text.subarray(5000, 9000));
    s.flush(C.ZSTD_e_end, () => {
      events.push('ended a frame');
      s.end(sources.text.subarray(9000, 12000));
    });
  });
  s.on('end', () => {
    console.log('stream flush:', events.join(', '));
    done();
  });
});
later('stream flush after end', (done) => {
  const s = zlib.createZstdCompress();
  s.resume();
  s.end('abc');
  s.flush(() => {
    console.log('stream flush after end: callback');
    done();
  });
});
later('stream reset drops params and dictionary', (done) => {
  const s = zlib.createZstdCompress({ dictionary: dict, params: { [C.ZSTD_c_compressionLevel]: 19, [C.ZSTD_c_checksumFlag]: 1 } });
  const parts = [];
  s.on('data', (c) => parts.push(c));
  s.write(record(1), () => {
    s.reset();
    s.end(record(2));
  });
  s.on('end', () => {
    const out = Buffer.concat(parts);
    console.log('stream reset drops params and dictionary:', describe(out));
    show('stream reset frame decodes without the dictionary', () => zlib.zstdDecompressSync(out).equals(record(2)));
    done();
  });
});
later('stream close', (done) => {
  const s = zlib.createZstdCompress();
  s.write('abc');
  s.close(() => {
    console.log('stream close:', s.destroyed, s._closed);
    show('stream reset after close', () => s.reset());
    done();
  });
});
later('stream write after end', (done) => {
  const s = zlib.createZstdCompress();
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
    zlib.createZstdCompress(level(4)),
    zlib.createZstdDecompress(),
    new Writable({ write(c, e, cb) { parts.push(c); cb(); } }),
    (err) => {
      console.log('pipeline:', err, Buffer.concat(parts).equals(sources.text));
      done();
    }
  );
});

const next = () => {
  const item = queue.shift();
  if (!item) return;
  item[1](() => setImmediate(next));
};
next();
