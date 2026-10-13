/**
 * stream / stream/promises — lazy-loaded readable-stream v4 (MIT).
 */
import { trackPromise } from '../async-handles.mjs';
import { loadVendorCjs } from '../vendor-load.mjs';
import { EventEmitter } from './events.mjs';

const PACKAGE_ROOT = '/node_modules/@ai-ecoverse/slicc-jsh';

let cached;

function getStreamApi({ ctx, process, Buffer }) {
  if (cached) return cached;
  const mod = loadVendorCjs({
    ctx,
    packageRoot: PACKAGE_ROOT,
    name: 'readable-stream',
    globals: { process, Buffer },
    process,
    requires: { events: EventEmitter },
  });
  // readable-stream's browser entry exports Readable; Node's `stream` is the
  // legacy Stream constructor carrying Readable, Writable, …, pipeline (which
  // lib/stream.js builds and the entry re-exports as .Stream).
  cached = mod.Stream ?? mod;
  // Node's fromWeb / toWeb (lib/internal/webstreams/adapters.js, in
  // src/node-lib): readable-stream leaves them to an adapters object it
  // never fills.
  const adapters = () => process._nodeLib().webstreamsAdapters;
  const { Readable, Writable, Duplex } = cached;
  Readable.fromWeb = (readableStream, options) => adapters().newStreamReadableFromReadableStream(readableStream, options);
  Readable.toWeb = (streamReadable, options) => adapters().newReadableStreamFromStreamReadable(streamReadable, options);
  Writable.fromWeb = (writableStream, options) => adapters().newStreamWritableFromWritableStream(writableStream, options);
  Writable.toWeb = (streamWritable) => adapters().newWritableStreamFromStreamWritable(streamWritable);
  Duplex.fromWeb = (pair, options) => adapters().newStreamDuplexFromReadableWritablePair(pair, options);
  Duplex.toWeb = (duplex) => adapters().newReadableWritablePairFromDuplex(duplex);
  return cached;
}

export function createStream({ ctx, process, Buffer, handles }) {
  void handles;
  return getStreamApi({ ctx, process, Buffer });
}

export function createStreamPromises(stream, handles) {
  return {
    pipeline(...args) {
      const p = new Promise((resolve, reject) => {
        const cb = (err) => (err ? reject(err) : resolve());
        stream.pipeline(...args, cb);
      });
      return handles ? trackPromise(handles, p) : p;
    },
    finished(strm, opts) {
      const p = new Promise((resolve, reject) => {
        stream.finished(strm, opts ?? {}, (err) => (err ? reject(err) : resolve()));
      });
      return handles ? trackPromise(handles, p) : p;
    },
  };
}
