/**
 * stream / stream/promises — lazy-loaded readable-stream v4 (MIT).
 */
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
  // Keep the Stream function export; only drop ESM interop `.default`.
  try {
    delete mod.default;
  } catch {
    /* ignore */
  }
  cached = mod;
  return cached;
}

export function createStream({ ctx, process, Buffer }) {
  return getStreamApi({ ctx, process, Buffer });
}

export function createStreamPromises(stream) {
  return {
    pipeline(...args) {
      return new Promise((resolve, reject) => {
        const cb = (err) => (err ? reject(err) : resolve());
        stream.pipeline(...args, cb);
      });
    },
    finished(strm, opts) {
      return new Promise((resolve, reject) => {
        stream.finished(strm, opts ?? {}, (err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
