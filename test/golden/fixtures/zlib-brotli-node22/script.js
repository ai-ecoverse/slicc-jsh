const zlib = require('zlib');
const fs = require('fs');
const { promisify } = require('util');
const { pipeline, Readable, Transform, Writable } = require('stream');
const { sources, large } = require('./sources.js');

const C = zlib.constants;
const data = fs.readFileSync(`${__dirname}/data.br`);
const entries = require('./data.json');
const br = Object.fromEntries(entries.map((e) => [e.name, data.subarray(e.offset, e.offset + e.length)]));

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

// Every stream decodes to its source, synchronously and through the callback.
for (const e of entries) {
  const name = e.name.split(' ')[0];
  if (name === 'large') continue;
  const opts = e.name.includes('large-window') ? { params: { [C.BROTLI_DECODER_PARAM_LARGE_WINDOW]: true } } : {};
  const expected = sources[name];
  show(`sync ${e.name}`, () => {
    const out = zlib.brotliDecompressSync(br[e.name], opts);
    return out.equals(expected) ? `ok <${out.length}>` : `MISMATCH ${describe(out)}`;
  });
}

// Inputs and options.
const text = br['text q11 w24'];
show('string input', () => zlib.brotliDecompressSync(br['tiny q11 w24'].toString('latin1')));
show('Uint8Array input', () => zlib.brotliDecompressSync(new Uint8Array(text)));
show('ArrayBuffer input', () => zlib.brotliDecompressSync(text.buffer.slice(text.byteOffset, text.byteOffset + text.length)));
show('DataView input', () => zlib.brotliDecompressSync(new DataView(text.buffer, text.byteOffset, text.length)));
show('number input', () => zlib.brotliDecompressSync(42));
show('null input', () => zlib.brotliDecompressSync(null));
show('info', () => zlib.brotliDecompressSync(text, { info: true }));
show('info, trailing bytes', () => zlib.brotliDecompressSync(Buffer.concat([text, Buffer.from('trailing')]), { info: true }));
show('chunkSize 64', () => zlib.brotliDecompressSync(text, { chunkSize: 64 }));
show('chunkSize 63', () => zlib.brotliDecompressSync(text, { chunkSize: 63 }));
show('chunkSize Infinity', () => zlib.brotliDecompressSync(text, { chunkSize: Infinity }));
show('chunkSize NaN is the default', () => zlib.brotliDecompressSync(text, { chunkSize: NaN }));
show('chunkSize string', () => zlib.brotliDecompressSync(text, { chunkSize: '64' }));
show('maxOutputLength', () => zlib.brotliDecompressSync(text, { maxOutputLength: 100 }));
show('maxOutputLength exact', () => zlib.brotliDecompressSync(text, { maxOutputLength: sources.text.length }));
show('maxOutputLength 0', () => zlib.brotliDecompressSync(text, { maxOutputLength: 0 }));
show('maxOutputLength 2**53', () => zlib.brotliDecompressSync(text, { maxOutputLength: 2 ** 53 }));
show('flush 3', () => zlib.brotliDecompressSync(text, { flush: C.BROTLI_OPERATION_EMIT_METADATA }));
show('flush 4', () => zlib.brotliDecompressSync(text, { flush: 4 }));
show('finishFlush -1', () => zlib.brotliDecompressSync(text, { finishFlush: -1 }));
show('finishFlush FLUSH, truncated', () => zlib.brotliDecompressSync(text.subarray(0, 900), { finishFlush: C.BROTLI_OPERATION_FLUSH }));
show('finishFlush PROCESS, truncated', () => zlib.brotliDecompressSync(text.subarray(0, 900), { finishFlush: C.BROTLI_OPERATION_PROCESS }));
show('params LARGE_WINDOW', () => zlib.brotliDecompressSync(text, { params: { [C.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 1 } }));
show('params DISABLE_RING_BUFFER_REALLOCATION', () =>
  zlib.brotliDecompressSync(text, { params: { [C.BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION]: true } })
);
show('large window without the param', () => zlib.brotliDecompressSync(br['text large-window w26']));
show('params: encoder parameter', () => zlib.brotliDecompressSync(text, { params: { [C.BROTLI_PARAM_QUALITY]: 4 } }));
show('params: key 9', () => zlib.brotliDecompressSync(text, { params: { 9: 1 } }));
show('params: key -1', () => zlib.brotliDecompressSync(text, { params: { '-1': 1 } }));
show('params: key abc', () => zlib.brotliDecompressSync(text, { params: { abc: 1 } }));
show('params: key 0 twice', () => zlib.brotliDecompressSync(text, { params: { 0: 1, '00': 1 } }));
show('params: string value', () => zlib.brotliDecompressSync(text, { params: { 0: '1' } }));
show('params: null', () => zlib.brotliDecompressSync(text, { params: null }));
show('params: value -1 is unset', () => zlib.brotliDecompressSync(text, { params: { 2: -1 } }));
show('params before chunkSize', () => zlib.brotliDecompressSync(text, { params: { 9: 1 }, chunkSize: 1 }));
show('encoding option ignored', () => zlib.brotliDecompressSync(text, { encoding: 'hex', objectMode: true }));

// Corrupt and truncated input.
show('empty', () => zlib.brotliDecompressSync(Buffer.alloc(0)));
show('not brotli', () => zlib.brotliDecompressSync(Buffer.from('not brotli data at all')));
for (const name of ['text q5 w16', 'json q11 w24', 'binary q9 w10', 'utf8 q1 w16']) {
  const input = br[name];
  for (const cut of [1, 2, 5, Math.floor(input.length / 2), input.length - 1]) {
    show(`${name} truncated to ${cut}`, () => zlib.brotliDecompressSync(input.subarray(0, cut)));
  }
  for (let i = 0; i < 24; i++) {
    const at = (i * 7919) % input.length;
    const bit = 1 << (i % 8);
    const corrupt = Buffer.from(input);
    corrupt[at] ^= bit;
    show(`${name} bit ${i % 8} of byte ${at} flipped`, () => zlib.brotliDecompressSync(corrupt));
  }
}

// The constructor and the factory.
show('BrotliDecompress without new', () => zlib.BrotliDecompress() instanceof zlib.BrotliDecompress);
show('createBrotliDecompress', () => {
  const d = zlib.createBrotliDecompress();
  return [d instanceof zlib.BrotliDecompress, d instanceof Transform, d._closed, d.bytesWritten, d._chunkSize, d.readableObjectMode];
});
show('names', () => [zlib.BrotliDecompress.name, typeof zlib.brotliDecompress, typeof zlib.brotliDecompressSync]);
show('stream option errors', () => zlib.createBrotliDecompress({ chunkSize: 10 }));
show('stream params error', () => new zlib.BrotliDecompress({ params: { 2: 0 } }));

// The callback form.
later('callback', (done) => zlib.brotliDecompress(text, (err, out) => done(err ? error(err) : describe(out))));
later('callback with options', (done) =>
  zlib.brotliDecompress(text, { chunkSize: 128, info: true }, (err, out) => done(err ? error(err) : describe(out)))
);
later('callback, Uint16Array input', (done) =>
  zlib.brotliDecompress(new Uint16Array(text.buffer.slice(text.byteOffset, text.byteOffset + (text.length & ~1))), (err, out) =>
    done(err ? error(err) : describe(out))
  )
);
later('callback, ArrayBuffer input', (done) =>
  zlib.brotliDecompress(text.buffer.slice(text.byteOffset, text.byteOffset + text.length), (err, out) =>
    done(err ? error(err) : describe(out))
  )
);
later('callback, corrupt', (done) => zlib.brotliDecompress(Buffer.from('nope'), (err, out) => done(err ? error(err) : describe(out))));
later('callback, truncated', (done) => zlib.brotliDecompress(text.subarray(0, 100), (err, out) => done(err ? error(err) : describe(out))));
later('callback, empty', (done) => zlib.brotliDecompress(Buffer.alloc(0), (err, out) => done(err ? error(err) : describe(out))));
later('callback, maxOutputLength', (done) =>
  zlib.brotliDecompress(text, { maxOutputLength: 1000 }, (err, out) => done(err ? error(err) : describe(out)))
);
later('callback missing', (done) => {
  try {
    zlib.brotliDecompress(text);
    done('no throw');
  } catch (e) {
    done(`THROW ${error(e)}`);
  }
});
later('callback, option error throws', (done) => {
  try {
    zlib.brotliDecompress(text, { chunkSize: 1 }, () => done('called'));
    done('no throw');
  } catch (e) {
    done(`THROW ${error(e)}`);
  }
});
later('promisify', (done) =>
  promisify(zlib.brotliDecompress)(br['json q9 w16']).then(
    (out) => done(out.equals(sources.json)),
    (err) => done(error(err))
  )
);

// Streams: writes of a few bytes, each write's output as it arrives. A
// stream that ends while written to (trailing bytes) logs no write callbacks:
// jsh's streams call the callback before 'end' (not Brotli's doing).
function streamLog(input, size, opts, done, { writes = true } = {}) {
  const d = zlib.createBrotliDecompress(opts);
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
      if (writes) log.push(`written ${at} ${err ? 'err' : 'ok'}`);
      setImmediate(next);
    });
  };
  next();
}
later('stream, 1-byte writes', (done) => streamLog(br['text q5 w16'].subarray(0, 120), 1, {}, done));
later('stream, 7-byte writes, chunkSize 64', (done) => streamLog(br['json q11 w24'], 7, { chunkSize: 64 }, done));
later('stream, 100-byte writes, binary', (done) => streamLog(br['binary q0 w10'], 100, { chunkSize: 256 }, done));
later('stream, uncompressed metablocks', (done) => streamLog(br['binary q11 w24'], 33, {}, done));
later('stream, corrupt', (done) => {
  const corrupt = Buffer.from(br['text q9 w16']);
  corrupt[300] ^= 0x10;
  streamLog(corrupt, 50, {}, done);
});
later('stream, truncated', (done) => streamLog(br['utf8 q11 w24'].subarray(0, 200), 64, {}, done));
later('stream, trailing bytes', (done) =>
  streamLog(Buffer.concat([br['tiny q5 w16'], Buffer.from('xyz')]), 4, {}, done, { writes: false })
);
later('stream, rejectGarbageAfterEnd', (done) =>
  streamLog(Buffer.concat([br['tiny q5 w16'], Buffer.from('xyz')]), 64, { rejectGarbageAfterEnd: true }, done, {
    writes: false,
  })
);
later('stream, finishFlush FLUSH, truncated', (done) =>
  streamLog(br['text q5 w16'].subarray(0, 500), 64, { finishFlush: C.BROTLI_OPERATION_FLUSH }, done)
);
later('stream, flush option', (done) => streamLog(br['text q1 w10'], 300, { flush: C.BROTLI_OPERATION_FLUSH }, done));

later('flush()', (done) => {
  const d = zlib.createBrotliDecompress();
  const log = [];
  d.on('data', (chunk) => log.push(`data ${chunk.length}`));
  d.write(text.subarray(0, 600));
  d.flush(() => {
    log.push('flushed');
    d.flush(C.BROTLI_OPERATION_PROCESS, () => {
      log.push('flushed again');
      d.end(text.subarray(600), () => {
        log.push('ended');
        d.flush(() => done(`${log.join(', ')}, flush after end`));
      });
    });
  });
});
later('reset()', (done) => {
  const d = zlib.createBrotliDecompress();
  const out = [];
  d.on('data', (chunk) => out.push(chunk));
  d.write(br['text q5 w16'].subarray(0, 300), () => {
    d.reset();
    d.end(br['json q5 w16'], () => done(Buffer.concat(out).length));
  });
});
later('close() while writing', (done) => {
  const d = zlib.createBrotliDecompress();
  const log = [];
  d.on('data', (chunk) => log.push(`data ${chunk.length}`));
  d.on('close', () => log.push('close event'));
  // Whether the write's callback comes first is a race in Node (the thread
  // pool against setImmediate): not logged.
  d.write(text);
  d.close(() => {
    log.push(`close cb _closed ${d._closed} destroyed ${d.destroyed}`);
    setImmediate(() => done(log.join(', ')));
  });
});
later('write after error', (done) => {
  const d = zlib.createBrotliDecompress();
  const log = [];
  d.on('error', (e) => {
    log.push(`error ${e.code}`);
    d.write(Buffer.from('more'), (err) => {
      log.push(`write cb ${err && err.code}`);
      setImmediate(() => done(log.join(', ')));
    });
  });
  d.write(Buffer.from('not brotli data'));
});
// params() flushes with Z_SYNC_FLUSH, which for Brotli is BROTLI_OPERATION_FINISH.
later('params()', (done) => {
  const d = zlib.createBrotliDecompress();
  let thrown;
  try {
    d.params(10, 0);
  } catch (e) {
    thrown = `THROW ${error(e)}`;
  }
  d.on('error', (e) => setImmediate(() => done(`${thrown}, then error ${error(e)}`)));
  d.params(1, 0, () => done(`${thrown}, then called back`));
});
later('pipeline, from a Readable', (done) => {
  const parts = [];
  for (let i = 0; i < text.length; i += 333) parts.push(text.subarray(i, i + 333));
  const out = [];
  pipeline(
    Readable.from(parts),
    zlib.createBrotliDecompress(),
    new Writable({
      write(chunk, enc, cb) {
        out.push(chunk);
        cb();
      },
    }),
    (err) => done(err ? error(err) : Buffer.concat(out).equals(sources.text))
  );
});
later('async iteration, chunkSize 1024', async (done) => {
  const d = zlib.createBrotliDecompress({ chunkSize: 1024 });
  d.end(br['json q0 w10']);
  const sizes = [];
  for await (const chunk of d) sizes.push(chunk.length);
  done(sizes.join(' '));
});
later('backpressure: highWaterMark 1', (done) => {
  const d = zlib.createBrotliDecompress({ chunkSize: 64, highWaterMark: 1 });
  d.end(text);
  const sizes = [];
  const pull = () => {
    let chunk;
    while ((chunk = d.read()) !== null) sizes.push(chunk.length);
  };
  d.on('readable', pull);
  d.on('end', () => done(`${sizes.length} reads, ${sizes.reduce((a, b) => a + b, 0)} bytes`));
});

// A large payload: 17.6 MB through a 4 MB window.
later('large, sync', (done) => {
  const out = zlib.brotliDecompressSync(br['large q5 w22']);
  done(`<${out.length}> crc ${zlib.crc32(out)} equal ${out.equals(large())}`);
});
later('large, maxOutputLength', (done) => {
  try {
    zlib.brotliDecompressSync(br['large q5 w22'], { maxOutputLength: 5e6 });
    done('no throw');
  } catch (e) {
    done(`THROW ${error(e)}`);
  }
});
later('large, callback maxOutputLength', (done) =>
  zlib.brotliDecompress(br['large q5 w22'], { maxOutputLength: 5e6 }, (err, out) => done(err ? error(err) : describe(out)))
);
later('large, stream in 1000-byte writes', (done) => {
  const input = br['large q5 w22'];
  const d = zlib.createBrotliDecompress();
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
