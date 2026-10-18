const zlib = require('zlib');
const fs = require('fs');
const { promisify } = require('util');
const { pipeline, Readable, Transform, Writable } = require('stream');
const { sources, large, record } = require('./sources.js');

const C = zlib.constants;
const data = fs.readFileSync(`${__dirname}/data.zst`);
const dict = fs.readFileSync(`${__dirname}/dict.bin`);
const entries = require('./data.json');
const zst = Object.fromEntries(entries.map((e) => [e.name, data.subarray(e.offset, e.offset + e.length)]));

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
const queue = [];
const later = (label, f) => queue.push([label, f]);
const skippable = (n, payload) => {
  const frame = Buffer.alloc(8 + payload.length);
  frame.writeUInt32LE(0x184d2a50 + n, 0);
  frame.writeUInt32LE(payload.length, 4);
  payload.copy(frame, 8);
  return frame;
};

show('process.versions.zstd', () => process.versions.zstd);

// Every frame decodes to its source, synchronously.
for (const e of entries) {
  const [name, n] = e.name.split(' ');
  if (name === 'large') continue;
  const expected = name === 'record' ? record(+n) : sources[name];
  const opts = {};
  if (e.name.includes('raw-dict')) opts.dictionary = sources.text;
  else if (e.name.includes('dict')) opts.dictionary = dict;
  if (e.name.includes('w28')) opts.params = { [C.ZSTD_d_windowLogMax]: 28 };
  show(`sync ${e.name}`, () => {
    const out = zlib.zstdDecompressSync(zst[e.name], opts);
    return out.equals(expected) ? `ok <${out.length}>` : `MISMATCH ${describe(out)}`;
  });
}

// Frames: several, skippable, garbage after, a window over the limit, dictionaries.
const text = zst['text l3 w17'];
const json = zst['json l9 w23'];
show('two frames: the first only', () => zlib.zstdDecompressSync(Buffer.concat([text, json])));
show('frame then garbage', () => zlib.zstdDecompressSync(Buffer.concat([json, Buffer.from('garbage')])));
show('skippable then frame', () => zlib.zstdDecompressSync(Buffer.concat([skippable(0, Buffer.from('skip me')), json])));
show('skippable 15, empty, then frame', () => zlib.zstdDecompressSync(Buffer.concat([skippable(15, Buffer.alloc(0)), json])));
show('skippable only', () => zlib.zstdDecompressSync(skippable(3, Buffer.from('nothing else'))));
show('skippable, truncated', () => zlib.zstdDecompressSync(skippable(3, Buffer.from('nothing else')).subarray(0, 12)));
show('empty frame twice', () => zlib.zstdDecompressSync(Buffer.concat([zst['empty l1 w10'], zst['empty l1 w10']])));
show('window 2**28 over the default limit', () => zlib.zstdDecompressSync(zst['text streamed w28']));
show('window 2**28, windowLogMax 27', () => zlib.zstdDecompressSync(zst['text streamed w28'], { params: { [C.ZSTD_d_windowLogMax]: 27 } }));
show('window 2**27, windowLogMax 26', () => zlib.zstdDecompressSync(zst['medium streamed w27'], { params: { [C.ZSTD_d_windowLogMax]: 26 } }));
show('window 2**23, windowLogMax 10', () => zlib.zstdDecompressSync(zst['medium l19 w23'], { params: { [C.ZSTD_d_windowLogMax]: 10 } }));
show('window 2**10, windowLogMax 10', () => zlib.zstdDecompressSync(zst['text l3 w10'], { params: { [C.ZSTD_d_windowLogMax]: 10 } }));
show('windowLogMax 0 is the default', () => zlib.zstdDecompressSync(zst['text streamed w28'], { params: { [C.ZSTD_d_windowLogMax]: 0 } }));
show('windowLogMax 9', () => zlib.zstdDecompressSync(text, { params: { [C.ZSTD_d_windowLogMax]: 9 } }));
show('windowLogMax 32', () => zlib.zstdDecompressSync(text, { params: { [C.ZSTD_d_windowLogMax]: 32 } }));
show('windowLogMax 31', () => zlib.zstdDecompressSync(text, { params: { [C.ZSTD_d_windowLogMax]: 31 } }));
show('windowLogMax true', () => zlib.zstdDecompressSync(text, { params: { [C.ZSTD_d_windowLogMax]: true } }));
show('windowLogMax 27.9', () => zlib.zstdDecompressSync(zst['medium streamed w27'], { params: { [C.ZSTD_d_windowLogMax]: 27.9 } }));
show('dictionary frame without it', () => zlib.zstdDecompressSync(zst['record 0 dict l1']));
show('dictionary frame, other dictionary', () => zlib.zstdDecompressSync(zst['record 0 dict l1'], { dictionary: sources.text }));
show('no-id dictionary frame without it', () => zlib.zstdDecompressSync(zst['record 3 dict no-id']));
show('raw-dict frame without it', () => zlib.zstdDecompressSync(zst['json raw-dict']));
show('raw-dict frame, other dictionary', () => zlib.zstdDecompressSync(zst['json raw-dict'], { dictionary: sources.json }));
show('plain frame with a dictionary', () => zlib.zstdDecompressSync(json, { dictionary: dict }));
show('dictionary as Uint16Array', () => zlib.zstdDecompressSync(zst['record 1 dict l19'], { dictionary: new Uint16Array(dict.buffer.slice(dict.byteOffset, dict.byteOffset + dict.length)) }).equals(record(1)));
show('dictionary as DataView', () => zlib.zstdDecompressSync(zst['record 1 dict l19'], { dictionary: new DataView(dict.buffer, dict.byteOffset, dict.length) }).equals(record(1)));
show('dictionary as ArrayBuffer is ignored', () => zlib.zstdDecompressSync(zst['record 1 dict l19'], { dictionary: dict.buffer.slice(dict.byteOffset, dict.byteOffset + dict.length) }));
show('dictionary as string is ignored', () => zlib.zstdDecompressSync(text, { dictionary: 'abc' }));
show('dictionary empty is none', () => zlib.zstdDecompressSync(text, { dictionary: Buffer.alloc(0) }));
show('dictionary truncated', () => zlib.zstdDecompressSync(text, { dictionary: dict.subarray(0, 100) }));
show('dictionary header only', () => zlib.zstdDecompressSync(text, { dictionary: dict.subarray(0, 8) }));
for (const at of [9, 20, 60, 130]) {
  const bad = Buffer.from(dict);
  bad[at] ^= 0xff;
  show(`dictionary byte ${at} corrupt`, () => zlib.zstdDecompressSync(zst['record 2 dict l1'], { dictionary: bad }));
}
show('dictionary content corrupt', () => {
  const bad = Buffer.from(dict);
  bad[4000] ^= 0xff;
  return zlib.zstdDecompressSync(zst['record 2 dict l19'], { dictionary: bad });
});

// Inputs and options.
show('string input', () => zlib.zstdDecompressSync(zst['tiny l1 w10'].toString('latin1')));
show('Uint8Array input', () => zlib.zstdDecompressSync(new Uint8Array(text)));
show('ArrayBuffer input', () => zlib.zstdDecompressSync(text.buffer.slice(text.byteOffset, text.byteOffset + text.length)));
show('DataView input', () => zlib.zstdDecompressSync(new DataView(text.buffer, text.byteOffset, text.length)));
show('number input', () => zlib.zstdDecompressSync(42));
show('null input', () => zlib.zstdDecompressSync(null));
show('info', () => zlib.zstdDecompressSync(text, { info: true }));
show('info, two frames', () => zlib.zstdDecompressSync(Buffer.concat([text, text]), { info: true }));
show('chunkSize 64', () => zlib.zstdDecompressSync(text, { chunkSize: 64 }));
show('chunkSize 63', () => zlib.zstdDecompressSync(text, { chunkSize: 63 }));
show('chunkSize NaN is the default', () => zlib.zstdDecompressSync(text, { chunkSize: NaN }));
show('maxOutputLength', () => zlib.zstdDecompressSync(text, { maxOutputLength: 100 }));
show('maxOutputLength exact', () => zlib.zstdDecompressSync(text, { maxOutputLength: sources.text.length }));
show('maxOutputLength one short', () => zlib.zstdDecompressSync(text, { maxOutputLength: sources.text.length - 1 }));
show('maxOutputLength 0', () => zlib.zstdDecompressSync(text, { maxOutputLength: 0 }));
show('flush 2', () => zlib.zstdDecompressSync(text, { flush: C.ZSTD_e_end }));
show('flush 3', () => zlib.zstdDecompressSync(text, { flush: 3 }));
show('finishFlush -1', () => zlib.zstdDecompressSync(text, { finishFlush: -1 }));
show('finishFlush continue', () => zlib.zstdDecompressSync(text, { finishFlush: C.ZSTD_e_continue }));
show('finishFlush flush, truncated', () => zlib.zstdDecompressSync(text.subarray(0, 900), { finishFlush: C.ZSTD_e_flush }));
show('params: encoder parameter', () => zlib.zstdDecompressSync(text, { params: { [C.ZSTD_c_compressionLevel]: 4 } }));
show('params: key 101', () => zlib.zstdDecompressSync(text, { params: { 101: 1 } }));
show('params: key -1', () => zlib.zstdDecompressSync(text, { params: { '-1': 1 } }));
show('params: key abc', () => zlib.zstdDecompressSync(text, { params: { abc: 1 } }));
show('params: key 100 twice', () => zlib.zstdDecompressSync(text, { params: { 100: 20, '100.0': 20 } }));
show('params: string value', () => zlib.zstdDecompressSync(text, { params: { 100: '20' } }));
show('params: null', () => zlib.zstdDecompressSync(text, { params: null }));
show('params: value -1 is unset', () => zlib.zstdDecompressSync(text, { params: { 50: -1 } }));
show('params before chunkSize', () => zlib.zstdDecompressSync(text, { params: { 200: 1 }, chunkSize: 1 }));
show('pledgedSrcSize -1', () => zlib.zstdDecompressSync(text, { pledgedSrcSize: -1 }));
show('pledgedSrcSize -0.5', () => zlib.zstdDecompressSync(text, { pledgedSrcSize: -0.5 }));
show('pledgedSrcSize NaN', () => zlib.zstdDecompressSync(text, { pledgedSrcSize: NaN }));
show('pledgedSrcSize wrong', () => zlib.zstdDecompressSync(text, { pledgedSrcSize: 3 }));
show('pledgedSrcSize string', () => zlib.zstdDecompressSync(text, { pledgedSrcSize: '-1' }));
show('pledgedSrcSize -1 before params', () => zlib.zstdDecompressSync(text, { pledgedSrcSize: -1, params: { 9: 1 } }));
show('encoding option ignored', () => zlib.zstdDecompressSync(text, { encoding: 'hex', objectMode: true }));

// Corrupt and truncated input: no error for a cut frame, as in Node.
show('empty', () => zlib.zstdDecompressSync(Buffer.alloc(0)));
show('not zstd', () => zlib.zstdDecompressSync(Buffer.from('not zstd data at all')));
show('magic only', () => zlib.zstdDecompressSync(text.subarray(0, 4)));
show('reserved bit', () => {
  const bad = Buffer.from(text);
  bad[4] |= 0x08;
  return zlib.zstdDecompressSync(bad);
});
show('checksum wrong', () => {
  const bad = Buffer.from(zst['text checksum']);
  bad[bad.length - 1] ^= 1;
  return zlib.zstdDecompressSync(bad);
});
show('checksum truncated', () => zlib.zstdDecompressSync(zst['text checksum'].subarray(0, zst['text checksum'].length - 2)));
for (const name of ['text l3 w17', 'json l19 w23', 'binary l1 w10', 'utf8 l-5 w17', 'medium l19 w23', 'record 1 dict l19']) {
  const input = zst[name];
  const opts = name.includes('dict') ? { dictionary: dict } : {};
  for (const cut of [1, 5, 6, Math.floor(input.length / 2), input.length - 1]) {
    show(`${name} truncated to ${cut}`, () => zlib.zstdDecompressSync(input.subarray(0, cut), opts));
  }
  for (let i = 0; i < 24; i++) {
    const at = (i * 7919) % input.length;
    const bit = 1 << (i % 8);
    const corrupt = Buffer.from(input);
    corrupt[at] ^= bit;
    show(`${name} bit ${i % 8} of byte ${at} flipped`, () => zlib.zstdDecompressSync(corrupt, opts));
  }
}

// The constructor and the factory.
show('ZstdDecompress without new', () => zlib.ZstdDecompress());
show('createZstdDecompress', () => {
  const d = zlib.createZstdDecompress();
  return [d instanceof zlib.ZstdDecompress, d instanceof Transform, d._closed, d.bytesWritten, d._chunkSize, typeof d.params, d._writeState.length];
});
show('names', () => [zlib.ZstdDecompress.name, typeof zlib.zstdDecompress, typeof zlib.zstdDecompressSync, zlib.createZstdDecompress.name, zlib.createBrotliDecompress.name]);
show('stream option errors', () => zlib.createZstdDecompress({ chunkSize: 10 }));
show('stream params error', () => new zlib.ZstdDecompress({ params: { 100: 5 } }));
show('stream dictionary error', () => new zlib.ZstdDecompress({ dictionary: dict.subarray(0, 50) }));

// The callback form.
later('callback', (done) => zlib.zstdDecompress(text, (err, out) => done(err ? error(err) : describe(out))));
later('callback with options', (done) =>
  zlib.zstdDecompress(text, { chunkSize: 128, info: true }, (err, out) => done(err ? error(err) : describe(out)))
);
later('callback, dictionary', (done) =>
  zlib.zstdDecompress(zst['record 2 dict l19'], { dictionary: dict }, (err, out) => done(err ? error(err) : out.equals(record(2))))
);
later('callback, Uint16Array input', (done) =>
  zlib.zstdDecompress(new Uint16Array(text.buffer.slice(text.byteOffset, text.byteOffset + (text.length & ~1))), (err, out) =>
    done(err ? error(err) : describe(out))
  )
);
later('callback, corrupt', (done) => zlib.zstdDecompress(Buffer.from('nope'), (err, out) => done(err ? error(err) : describe(out))));
later('callback, checksum wrong', (done) => {
  const bad = Buffer.from(zst['text checksum']);
  bad[bad.length - 2] ^= 1;
  zlib.zstdDecompress(bad, (err, out) => done(err ? error(err) : describe(out)));
});
later('callback, truncated', (done) => zlib.zstdDecompress(text.subarray(0, 100), (err, out) => done(err ? error(err) : describe(out))));
later('callback, empty', (done) => zlib.zstdDecompress(Buffer.alloc(0), (err, out) => done(err ? error(err) : describe(out))));
later('callback, maxOutputLength', (done) =>
  zlib.zstdDecompress(text, { maxOutputLength: 1000 }, (err, out) => done(err ? error(err) : describe(out)))
);
later('callback missing', (done) => {
  try {
    zlib.zstdDecompress(text);
    done('no throw');
  } catch (e) {
    done(`THROW ${error(e)}`);
  }
});
later('callback, param error throws', (done) => {
  try {
    zlib.zstdDecompress(text, { params: { 100: 99 } }, () => done('called'));
    done('no throw');
  } catch (e) {
    done(`THROW ${error(e)}`);
  }
});
later('promisify', (done) =>
  promisify(zlib.zstdDecompress)(zst['json l3 w23']).then(
    (out) => done(out.equals(sources.json)),
    (err) => done(error(err))
  )
);
// Streams: writes of a few bytes, each write's output as it arrives.
function streamLog(input, size, opts, done) {
  const d = zlib.createZstdDecompress(opts);
  const log = [];
  const parts = [];
  d.on('data', (chunk) => {
    parts.push(chunk);
    log.push(`data ${chunk.length}`);
  });
  d.on('error', (e) => log.push(`error ${error(e)}`));
  d.on('end', () => log.push('end'));
  d.on('close', () => {
    log.push(`close crc ${zlib.crc32(Buffer.concat(parts))} bytesWritten ${d.bytesWritten}`);
    done(log.join(', '));
  });
  let at = 0;
  const next = () => {
    if (at >= input.length) return d.end();
    const piece = input.subarray(at, at + size);
    at += size;
    d.write(piece, (err) => {
      log.push(`written ${at} ${err ? 'err' : 'ok'}`);
      setImmediate(next);
    });
  };
  next();
}
later('stream, 1-byte writes', (done) => streamLog(zst['text l19 w17'].subarray(0, 120), 1, {}, done));
later('stream, 1-byte writes, whole frame with checksum', (done) => streamLog(zst['text checksum'], 1, { chunkSize: 512 }, done));
later('stream, 7-byte writes, chunkSize 64', (done) => streamLog(zst['json l19 w23'], 7, { chunkSize: 64 }, done));
later('stream, 100-byte writes, binary', (done) => streamLog(zst['binary l-5 w10'], 100, { chunkSize: 256 }, done));
later('stream, 33-byte writes, dictionary', (done) => streamLog(zst['record 0 dict l19'], 33, { dictionary: dict }, done));
later('stream, two frames in one write', (done) => streamLog(Buffer.concat([zst['tiny l1 w10'], json]), 4096, {}, done));
later('stream, two frames in separate writes', (done) => streamLog(Buffer.concat([zst['tiny l1 w10'], json]), zst['tiny l1 w10'].length, {}, done));
later('stream, skippable frames', (done) =>
  streamLog(Buffer.concat([skippable(1, Buffer.alloc(40, 1)), zst['utf8 l9 w17'], skippable(2, Buffer.alloc(3))]), 16, {}, done)
);
later('stream, corrupt', (done) => {
  const corrupt = Buffer.from(zst['text l9 w17']);
  corrupt[300] ^= 0x10;
  streamLog(corrupt, 50, {}, done);
});
later('stream, checksum wrong', (done) => {
  const bad = Buffer.from(zst['medium checksum no-size']);
  bad[bad.length - 3] ^= 4;
  streamLog(bad, 1000, {}, done);
});
later('stream, truncated', (done) => streamLog(zst['utf8 l19 w23'].subarray(0, 200), 64, {}, done));
later('stream, trailing bytes', (done) => streamLog(Buffer.concat([zst['tiny l1 w10'], Buffer.from('xyz')]), 4, {}, done));
later('stream, rejectGarbageAfterEnd', (done) =>
  streamLog(Buffer.concat([zst['tiny l1 w10'], Buffer.from('xyz')]), 64, { rejectGarbageAfterEnd: true }, done)
);
later('stream, window over the limit', (done) => streamLog(zst['text streamed w28'], 500, {}, done));
later('stream, window 2**27', (done) => streamLog(zst['medium streamed w27'], 2000, {}, done));
later('stream, flush option', (done) => streamLog(zst['text l1 w10'], 300, { flush: C.ZSTD_e_flush }, done));

later('flush()', (done) => {
  const d = zlib.createZstdDecompress();
  const log = [];
  d.on('data', (chunk) => log.push(`data ${chunk.length}`));
  d.write(text.subarray(0, 600));
  d.flush(() => {
    log.push('flushed');
    d.flush(C.ZSTD_e_continue, () => {
      log.push('flushed again');
      d.end(text.subarray(600), () => {
        log.push('ended');
        d.flush(() => done(`${log.join(', ')}, flush after end`));
      });
    });
  });
});
later('reset()', (done) => {
  const d = zlib.createZstdDecompress();
  const out = [];
  d.on('data', (chunk) => out.push(chunk));
  d.write(zst['text l3 w23'].subarray(0, 300), () => {
    d.reset();
    d.end(zst['json l3 w23'], () => done(Buffer.concat(out).length));
  });
});
// reset() makes a new context: the dictionary and the parameters are gone.
later('reset() drops the dictionary', (done) => {
  const d = zlib.createZstdDecompress({ dictionary: dict });
  const log = [];
  d.on('data', (chunk) => log.push(`data ${chunk.length}`));
  d.on('error', (e) => setImmediate(() => done(`${log.join(', ')}, error ${error(e)}`)));
  d.write(zst['record 0 dict l1'], () => {
    d.reset();
    d.end(zst['record 0 dict l1'], () => done(`${log.join(', ')}, ended`));
  });
});
later('reset() drops windowLogMax', (done) => {
  const d = zlib.createZstdDecompress({ params: { [C.ZSTD_d_windowLogMax]: 10 } });
  const log = [];
  d.on('data', (chunk) => log.push(`data ${chunk.length}`));
  d.on('error', (e) => setImmediate(() => done(`${log.join(', ')}, error ${error(e)}`)));
  d.reset();
  d.end(zst['text l3 w23'], () => done(`${log.join(', ')}, ended`));
});
later('close() while writing', (done) => {
  const d = zlib.createZstdDecompress();
  const log = [];
  d.on('data', (chunk) => log.push(`data ${chunk.length}`));
  d.on('close', () => log.push('close event'));
  d.write(text);
  d.close(() => {
    log.push(`close cb _closed ${d._closed} destroyed ${d.destroyed}`);
    setImmediate(() => done(log.join(', ')));
  });
});
later('write after error', (done) => {
  const d = zlib.createZstdDecompress();
  const log = [];
  d.on('error', (e) => {
    log.push(`error ${e.code}`);
    d.write(Buffer.from('more'), (err) => {
      log.push(`write cb ${err && err.code}`);
      setImmediate(() => done(log.join(', ')));
    });
  });
  d.write(Buffer.from('not zstd data'));
});
later('pipeline, from a Readable', (done) => {
  const input = zst['medium l1 w17'];
  const parts = [];
  for (let i = 0; i < input.length; i += 333) parts.push(input.subarray(i, i + 333));
  const out = [];
  pipeline(
    Readable.from(parts),
    zlib.createZstdDecompress(),
    new Writable({
      write(chunk, enc, cb) {
        out.push(chunk);
        cb();
      },
    }),
    (err) => done(err ? error(err) : Buffer.concat(out).equals(sources.medium))
  );
});
later('async iteration, chunkSize 1024', async (done) => {
  const d = zlib.createZstdDecompress({ chunkSize: 1024 });
  d.end(zst['json l-5 w10']);
  const sizes = [];
  for await (const chunk of d) sizes.push(chunk.length);
  done(sizes.join(' '));
});
later('backpressure: highWaterMark 1', (done) => {
  const d = zlib.createZstdDecompress({ chunkSize: 64, highWaterMark: 1 });
  d.end(text);
  const sizes = [];
  const pull = () => {
    let chunk;
    while ((chunk = d.read()) !== null) sizes.push(chunk.length);
  };
  d.on('readable', pull);
  d.on('end', () => done(`${sizes.length} reads, ${sizes.reduce((a, b) => a + b, 0)} bytes`));
});

// A large payload: 17.6 MB through an 8 MB window.
later('large, sync', (done) => {
  const out = zlib.zstdDecompressSync(zst['large l3 w23']);
  done(`<${out.length}> crc ${zlib.crc32(out)} equal ${out.equals(large())}`);
});
later('large, maxOutputLength', (done) => {
  try {
    zlib.zstdDecompressSync(zst['large l3 w23'], { maxOutputLength: 5e6 });
    done('no throw');
  } catch (e) {
    done(`THROW ${error(e)}`);
  }
});
later('large, callback maxOutputLength', (done) =>
  zlib.zstdDecompress(zst['large l3 w23'], { maxOutputLength: 5e6 }, (err, out) => done(err ? error(err) : describe(out)))
);
later('large, stream in 1000-byte writes', (done) => {
  const input = zst['large l3 w23'];
  const d = zlib.createZstdDecompress();
  let crc = 0;
  let length = 0;
  let chunks = 0;
  d.on('data', (chunk) => {
    crc = zlib.crc32(chunk, crc);
    length += chunk.length;
    chunks++;
  });
  d.on('end', () => done(`<${length}> crc ${crc} in ${chunks} chunks, bytesWritten ${d.bytesWritten}`));
  for (let i = 0; i < input.length; i += 1000) d.write(input.subarray(i, i + 1000));
  d.end();
});

(async () => {
  for (const [label, f] of queue) {
    const result = await new Promise((resolve) => f(resolve));
    console.log(`${label}: ${typeof result === 'string' ? result : JSON.stringify(result)}`);
  }
})();
