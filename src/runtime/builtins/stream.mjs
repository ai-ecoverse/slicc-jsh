/**
 * stream / stream/promises — lazy-loaded readable-stream v4 (MIT).
 */
import { trackPromise } from '../async-handles.mjs';
import { loadVendorCjs } from '../vendor-load.mjs';

const PACKAGE_ROOT = '/node_modules/@ai-ecoverse/slicc-jsh';

let cached;

function getStreamApi({ ctx, process, Buffer }) {
  if (cached) return cached;
  const mod = loadVendorCjs({
    ctx,
    packageRoot: PACKAGE_ROOT,
    name: 'readable-stream',
    globals: { process, Buffer },
  });
  try {
    delete mod.default;
  } catch {
    /* ignore */
  }
  cached = mod;
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
