/**
 * zlib: browserify-zlib 0.2.0 (MIT), a port of Node's lib/zlib.js onto pako
 * 1.0.11 (MIT AND Zlib), bundled lazily as dist/vendor/zlib.cjs. Its streams
 * are this runtime's readable-stream Transform, its Buffer ours.
 *
 * On top of the port: Node 22's `constants` and `codes`, `crc32`, and the
 * Brotli and Zstd entry points, which no pure-JS library here provides; they
 * throw ERR_FEATURE_UNAVAILABLE_ON_PLATFORM.
 */
import { loadVendorCjs } from '../vendor-load.mjs';
import { ZLIB_CODES, ZLIB_CONSTANTS } from './zlib-constants.mjs';

const PACKAGE_ROOT = '/node_modules/@ai-ecoverse/slicc-jsh';

let CRC_TABLE;
function crc32(data, value = 0) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let bytes;
  if (typeof data === 'string') bytes = new TextEncoder().encode(data);
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else {
    const err = new TypeError(
      `The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.`
    );
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  if (typeof value !== 'number') throw typeError('value', 'of type number', value);
  let crc = (value ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function received(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `type string ('${value}')`;
  if (typeof value === 'function') return `function ${value.name || '<anonymous>'}`;
  if (typeof value === 'object') return `an instance of ${value.constructor?.name || 'Object'}`;
  return `type ${typeof value} (${String(value)})`;
}

function typeError(name, expected, value) {
  const what = name.includes('.') ? 'property' : 'argument';
  const err = new TypeError(`The "${name}" ${what} must be ${expected}. Received ${received(value)}`);
  err.code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

function rangeError(name, range, value) {
  const err = new RangeError(
    `The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`
  );
  err.code = 'ERR_OUT_OF_RANGE';
  return err;
}

// Node 22 lib/zlib.js: checkFiniteNumber / checkRangesOrGetDefault.
function checkFiniteNumber(number, name) {
  if (number === undefined) return false;
  if (Number.isFinite(number)) return true;
  if (typeof number !== 'number') throw typeError(name, 'of type number', number);
  throw rangeError(name, 'a finite number', number);
}

function checkRanges(number, name, lower, upper, def) {
  if (!checkFiniteNumber(number, name)) return def;
  if (number < lower || number > upper) throw rangeError(name, `>= ${lower} and <= ${upper}`, number);
  return number;
}

// browserify-zlib's binding modes.
const INFLATE = 2;
const GZIP = 3;
const GUNZIP = 4;
const DEFLATERAW = 5;
const UNZIP = 7;

/** What the patched port calls first in Zlib(opts, mode); see scripts/build.mjs. */
function zlibOptionsHelpers(Buffer) {
  const c = ZLIB_CONSTANTS;
  return {
    options(opts, mode) {
      let chunkSize = opts.chunkSize;
      if (!checkFiniteNumber(chunkSize, 'options.chunkSize')) chunkSize = c.Z_DEFAULT_CHUNK;
      else if (chunkSize < c.Z_MIN_CHUNK) throw rangeError('options.chunkSize', `>= ${c.Z_MIN_CHUNK}`, chunkSize);
      let windowBits;
      if ((opts.windowBits == null || opts.windowBits === 0) && (mode === INFLATE || mode === GUNZIP || mode === UNZIP)) {
        windowBits = 0;
      } else {
        const min = c.Z_MIN_WINDOWBITS + (mode === GZIP ? 1 : 0);
        windowBits = checkRanges(opts.windowBits, 'options.windowBits', min, c.Z_MAX_WINDOWBITS, c.Z_DEFAULT_WINDOWBITS);
        // zlib itself turns raw deflate's 8 into 9.
        if (mode === DEFLATERAW && windowBits === 8) windowBits = 9;
      }
      const level = checkRanges(opts.level, 'options.level', c.Z_MIN_LEVEL, c.Z_MAX_LEVEL, c.Z_DEFAULT_COMPRESSION);
      const memLevel = checkRanges(opts.memLevel, 'options.memLevel', c.Z_MIN_MEMLEVEL, c.Z_MAX_MEMLEVEL, c.Z_DEFAULT_MEMLEVEL);
      const strategy = checkRanges(opts.strategy, 'options.strategy', c.Z_DEFAULT_STRATEGY, c.Z_FIXED, c.Z_DEFAULT_STRATEGY);
      let dictionary = opts.dictionary;
      if (dictionary !== undefined) {
        if (ArrayBuffer.isView(dictionary)) {
          dictionary = Buffer.from(dictionary.buffer, dictionary.byteOffset, dictionary.byteLength);
        } else if (
          dictionary instanceof ArrayBuffer ||
          (typeof SharedArrayBuffer === 'function' && dictionary instanceof SharedArrayBuffer)
        ) {
          dictionary = Buffer.from(dictionary);
        } else {
          throw typeError('options.dictionary', 'an instance of Buffer, TypedArray, DataView, or ArrayBuffer', dictionary);
        }
      }
      return { ...opts, chunkSize, windowBits, level, memLevel, strategy, dictionary };
    },
    params(level, strategy) {
      const c = ZLIB_CONSTANTS;
      checkRanges(level, 'level', c.Z_MIN_LEVEL, c.Z_MAX_LEVEL);
      checkRanges(strategy, 'strategy', c.Z_DEFAULT_STRATEGY, c.Z_FIXED);
    },
    input(buffer) {
      if (typeof buffer === 'string') return Buffer.from(buffer);
      if (Buffer.isBuffer(buffer)) return buffer;
      if (ArrayBuffer.isView(buffer)) return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      if (buffer instanceof ArrayBuffer) return Buffer.from(buffer);
      throw typeError('buffer', 'of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer', buffer);
    },
  };
}

function unavailable(name) {
  return function notAvailable() {
    const err = new Error(`zlib.${name} is not available in slicc-jsh (no Brotli/Zstd implementation)`);
    err.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
    throw err;
  };
}

const UNAVAILABLE = [
  'BrotliCompress',
  'BrotliDecompress',
  'ZstdCompress',
  'ZstdDecompress',
  'brotliCompress',
  'brotliCompressSync',
  'brotliDecompress',
  'brotliDecompressSync',
  'zstdCompress',
  'zstdCompressSync',
  'zstdDecompress',
  'zstdDecompressSync',
  'createBrotliCompress',
  'createBrotliDecompress',
  'createZstdCompress',
  'createZstdDecompress',
];

export function createZlib({ ctx, process, Buffer, getStream, util, assert }) {
  const port = loadVendorCjs({
    ctx,
    packageRoot: PACKAGE_ROOT,
    name: 'zlib',
    globals: { process, Buffer },
    process,
    requires: { stream: getStream(), util, assert, '__jsh/zlib-options': zlibOptionsHelpers(Buffer) },
  });
  const zlib = {};
  for (const [key, value] of Object.entries(port)) {
    // Node 22 keeps the Z_* names on `constants` only.
    if (/^[A-Z][A-Z0-9_]+$/.test(key) && key !== 'Zlib') continue;
    zlib[key] = value;
  }
  delete zlib.Zlib;
  zlib.constants = ZLIB_CONSTANTS;
  zlib.codes = ZLIB_CODES;
  zlib.crc32 = crc32;
  for (const name of UNAVAILABLE) zlib[name] = unavailable(name);
  return zlib;
}
