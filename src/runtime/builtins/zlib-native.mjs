/**
 * zlib's Brotli and Zstd streams: Node 22.22.0's ZlibBase, Brotli,
 * BrotliCompress, BrotliDecompress, Zstd, ZstdCompress and ZstdDecompress
 * (lib/zlib.js) and the convenience methods, over the decoders in src/brotli
 * and src/zstd (Google's and Facebook's C decoders ported to JavaScript;
 * dist/vendor/brotli.cjs and zstd.cjs, evaluated on first use) and the
 * encoders of zlib-wasm.mjs. BrotliHandle, BrotliEncoderHandle, ZstdHandle
 * and ZstdCompressHandle stand in for the native binding.BrotliDecoder,
 * BrotliEncoder, ZstdDecompress and ZstdCompress (src/node_zlib.cc): an async
 * write does its work at once, as Node's thread pool starts on it, and calls
 * back after the current turn of the loop.
 */
import { ZLIB_CONSTANTS } from './zlib-constants.mjs';
import { ERR_INVALID_ARG_TYPE, ERR_OUT_OF_RANGE, nativeError, nodeError, validateFunction, validateNumber } from '../node-errors.mjs';

const {
  BROTLI_DECODE,
  BROTLI_ENCODE,
  ZSTD_COMPRESS,
  ZSTD_DECOMPRESS,
  ZSTD_e_continue,
  ZSTD_e_flush,
  ZSTD_e_end,
  BROTLI_OPERATION_PROCESS,
  BROTLI_OPERATION_FLUSH,
  BROTLI_OPERATION_FINISH,
  BROTLI_OPERATION_EMIT_METADATA,
  Z_NO_FLUSH,
  Z_BLOCK,
  Z_PARTIAL_FLUSH,
  Z_SYNC_FLUSH,
  Z_FULL_FLUSH,
  Z_FINISH,
  Z_BUF_ERROR,
  Z_MIN_CHUNK,
  Z_DEFAULT_CHUNK,
  Z_MIN_LEVEL,
  Z_MAX_LEVEL,
  Z_DEFAULT_STRATEGY,
  Z_FIXED,
} = ZLIB_CONSTANTS;

// buffer.kMaxLength in Node 22.
const kMaxLength = 2 ** 53 - 1;

const kMaxBrotliParam = Math.max(
  ...Object.entries(ZLIB_CONSTANTS).map(([key, value]) => (key.startsWith('BROTLI_PARAM_') ? value : 0))
);
const brotliInitParamsArray = new Uint32Array(kMaxBrotliParam + 1);
const kMaxZstdDParam = Math.max(
  ...Object.keys(ZLIB_CONSTANTS).map((key) => (key.startsWith('ZSTD_d_') ? ZLIB_CONSTANTS[key] : 0))
);
const zstdInitDParamsArray = new Uint32Array(kMaxZstdDParam + 1);
const kMaxZstdCParam = Math.max(
  ...Object.keys(ZLIB_CONSTANTS).map((key) => (key.startsWith('ZSTD_c_') ? ZLIB_CONSTANTS[key] : 0))
);
const zstdInitCParamsArray = new Uint32Array(kMaxZstdCParam + 1);

const FLUSH_BOUND_BROTLI = [BROTLI_OPERATION_PROCESS, BROTLI_OPERATION_EMIT_METADATA];
const FLUSH_BOUND_ZSTD = [ZSTD_e_continue, ZSTD_e_end];

const ERR_BUFFER_TOO_LARGE = (max) =>
  nodeError(RangeError, 'ERR_BUFFER_TOO_LARGE', `Cannot create a Buffer larger than ${max} bytes`);
const ERR_BROTLI_INVALID_PARAM = (value) =>
  nodeError(RangeError, 'ERR_BROTLI_INVALID_PARAM', `${value} is not a valid Brotli parameter`);
const ERR_ZSTD_INVALID_PARAM = (value) =>
  nodeError(RangeError, 'ERR_ZSTD_INVALID_PARAM', `${value} is not a valid zstd parameter`);
const ERR_ZLIB_INITIALIZATION_FAILED = (message) => nativeError(Error, 'ERR_ZLIB_INITIALIZATION_FAILED', message);

const isAnyArrayBuffer = (value) =>
  value instanceof ArrayBuffer ||
  (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer) ||
  ['[object ArrayBuffer]', '[object SharedArrayBuffer]'].includes(Object.prototype.toString.call(value));

function validateFiniteNumber(number, name) {
  // Common case
  if (number === undefined) return false;
  if (Number.isFinite(number)) return true; // Is a valid number
  if (Number.isNaN(number)) return false;
  validateNumber(number, name);
  // Infinite numbers
  throw ERR_OUT_OF_RANGE(name, 'a finite number', number);
}

function checkRangesOrGetDefault(number, name, lower, upper, def) {
  if (!validateFiniteNumber(number, name)) return def;
  if (number < lower || number > upper) throw ERR_OUT_OF_RANGE(name, `>= ${lower} and <= ${upper}`, number);
  return number;
}

// If a flush is scheduled while another flush is still pending, a way to
// figure out which one is the "stronger" flush is needed.
const flushiness = [];
const kFlushFlagList = [Z_NO_FLUSH, Z_BLOCK, Z_PARTIAL_FLUSH, Z_SYNC_FLUSH, Z_FULL_FLUSH, Z_FINISH];
for (let i = 0; i < kFlushFlagList.length; i++) flushiness[kFlushFlagList[i]] = i;
const maxFlush = (a, b) => (flushiness[a] > flushiness[b] ? a : b);

/**
 * The stream classes, given the runtime and the decoder modules
 * (src/brotli/decode.mjs, src/zstd/decompress.mjs) to load on first use.
 */
export function createNative({
  Buffer,
  getStream,
  process,
  util,
  setImmediate,
  loadBrotli,
  loadZstd,
  loadBrotliEncoder,
  loadZstdCompress,
}) {
  const { Transform, finished } = getStream();
  const kFlushFlag = Symbol('kFlushFlag');
  const kError = Symbol('kError');
  const owner = Symbol('owner_symbol');

  // 'Special' buffers written with .write() from .flush() to put flushing
  // operations into the write sequence.
  const kFlushBuffers = [];
  {
    const dummyArrayBuffer = new ArrayBuffer(0);
    for (const flushFlag of kFlushFlagList) {
      kFlushBuffers[flushFlag] = Buffer.from(dummyArrayBuffer);
      kFlushBuffers[flushFlag][kFlushFlag] = flushFlag;
    }
  }

  let brotliModule;
  const brotli = () => (brotliModule ??= loadBrotli());
  let zstdModule;
  const zstd = () => (zstdModule ??= loadZstd());
  let brotliEncoderModule;
  const brotliEncoder = () => (brotliEncoderModule ??= loadBrotliEncoder(brotli()));
  let zstdCompressModule;
  const zstdCompress = () => (zstdCompressModule ??= loadZstdCompress());
  const bytes = (view) => (view ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength) : new Uint8Array(0));

  /** CompressionStream<…Context>: the native handle's write, close and error paths. */
  class NativeHandle {
    constructor() {
      this.state = null;
      this.writeResult = null;
      this.writeCallback = null;
      this.writeInProgress = false;
      this.pendingClose = false;
      this.closed = false;
      this.flush = 0;
      this.errorCode = 0;
    }

    // Currently a no-op, as in Node.
    params() {}

    close() {
      if (this.writeInProgress) {
        this.pendingClose = true;
        return;
      }
      this.pendingClose = false;
      this.closed = true;
      this.state?.destroy?.();
      this.state = null;
    }

    // The work starts at once, as on Node's thread pool, and its result
    // comes back after this turn of the loop: a reset() or close() right
    // after write() comes after this write, as it nearly always does in Node.
    write(flush, input, inOff, inLen, out, outOff, outLen) {
      this.start(flush, input, inOff, inLen, out, outOff, outLen);
      this.doWork();
      setImmediate(() => this.afterWork());
    }

    writeSync(flush, input, inOff, inLen, out, outOff, outLen) {
      this.start(flush, input, inOff, inLen, out, outOff, outLen);
      this.doWork();
      if (this.checkError()) {
        this.updateWriteResult();
        this.writeInProgress = false;
      }
    }

    start(flush, input, inOff, inLen, out, outOff, outLen) {
      if (this.closed) throw new Error('zlib binding closed');
      this.writeInProgress = true;
      this.input = bytes(input);
      this.inOff = input ? inOff : 0;
      this.inLen = input ? inLen : 0;
      this.out = bytes(out);
      this.outOff = outOff;
      this.outLen = outLen;
      this.flush = flush;
    }

    afterWork() {
      this.writeInProgress = false;
      if (!this.checkError()) return;
      this.updateWriteResult();
      this.writeCallback.call(this);
      if (this.pendingClose) this.close();
    }

    updateWriteResult() {
      this.writeResult[0] = this.availOut;
      this.writeResult[1] = this.availIn;
    }

    emitError(message, errno, code) {
      if (typeof this.onerror === 'function') this.onerror(message, errno, code);
      // No hope of rescue.
      this.writeInProgress = false;
      if (this.pendingClose) this.close();
    }
  }

  /** binding.BrotliDecoder (CompressionStream<BrotliDecoderContext>). */
  class BrotliHandle extends NativeHandle {
    constructor(mode) {
      super();
      this.mode = mode;
      this.lastResult = 1;
    }

    init(params, writeResult, writeCallback) {
      this.writeResult = writeResult;
      this.writeCallback = writeCallback;
      this.state = new (brotli().BrotliDecoder)();
      for (let i = 0; i < params.length; i++) {
        if (params[i] === 0xffffffff) continue;
        if (!this.state.setParameter(i, params[i])) {
          this.emitError('Setting parameter failed', -1, 'ERR_BROTLI_PARAM_SET_FAILED');
          throw ERR_ZLIB_INITIALIZATION_FAILED('Initialization failed');
        }
      }
    }

    reset() {
      // ResetStream: a new decoder, without the parameters init set.
      this.state = new (brotli().BrotliDecoder)();
      this.lastResult = 1;
      this.errorCode = 0;
    }

    doWork() {
      const s = this.state;
      this.lastResult = s.decompress(this.input, this.inOff, this.inLen, this.out, this.outOff, this.outLen);
      this.availIn = s.availIn;
      this.availOut = s.availOut;
      this.input = null;
      this.out = null;
      if (this.lastResult === 0) this.errorCode = s.errorCode;
    }

    /** BrotliDecoderContext::GetErrorInfo. */
    checkError() {
      if (this.errorCode !== 0) {
        this.emitError('Decompression failed', this.errorCode, `ERR_${brotli().errorString(this.errorCode)}`);
        return false;
      }
      if (this.flush === BROTLI_OPERATION_FINISH && this.lastResult === 2) {
        // Match zlib's behaviour, as brotli doesn't have its own code for this.
        this.emitError('unexpected end of file', Z_BUF_ERROR, 'Z_BUF_ERROR');
        return false;
      }
      return true;
    }
  }

  class BrotliEncoderHandle extends NativeHandle {
    init(params, writeResult, writeCallback) {
      this.writeResult = writeResult;
      this.writeCallback = writeCallback;
      this.reset();
      if (!this.state.ok) {
        this.emitError('Could not initialize Brotli instance', -1, 'ERR_ZLIB_INITIALIZATION_FAILED');
        throw ERR_ZLIB_INITIALIZATION_FAILED('Initialization failed');
      }
      for (let i = 0; i < params.length; i++) {
        if (params[i] === 0xffffffff) continue;
        if (!this.state.setParameter(i, params[i])) {
          this.emitError('Setting parameter failed', -1, 'ERR_BROTLI_PARAM_SET_FAILED');
          throw ERR_ZLIB_INITIALIZATION_FAILED('Initialization failed');
        }
      }
    }

    reset() {
      this.state?.destroy();
      this.state = new (brotliEncoder().BrotliEncoder)();
    }

    doWork() {
      const s = this.state;
      try {
        this.lastResult = s.compressStream(this.flush, this.input, this.inOff, this.inLen, this.out, this.outOff, this.outLen);
      } catch (err) {
        if (!(err instanceof WebAssembly.RuntimeError)) throw err;
        this.lastResult = false;
      }
      this.availIn = s.availIn;
      this.availOut = s.availOut;
      this.input = null;
      this.out = null;
    }

    checkError() {
      if (!this.lastResult) {
        this.emitError('Compression failed', -1, 'ERR_BROTLI_COMPRESSION_FAILED');
        return false;
      }
      return true;
    }
  }

  /** binding.ZstdDecompress (ZstdStream<ZstdDecompressContext>). */
  class ZstdHandle extends NativeHandle {
    init(params, pledgedSrcSize, writeResult, writeCallback, dictionary) {
      this.writeResult = writeResult;
      this.writeCallback = writeCallback;
      if (typeof pledgedSrcSize === 'number') {
        // IntegerValue: NaN is 0; it is only checked, decompression ignores it.
        if (Math.trunc(pledgedSrcSize) < 0) {
          throw nativeError(TypeError, 'ERR_INVALID_ARG_VALUE', 'pledgedSrcSize may not be negative');
        }
      }
      const z = zstd();
      this.state = new z.DCtx();
      if (dictionary !== undefined && dictionary.byteLength !== 0) {
        if (z.loadDictionary(this.state, Uint8Array.from(bytes(dictionary))) < 0) {
          this.emitError('Failed to load zstd dictionary', -1, 'ERR_ZLIB_DICTIONARY_LOAD_FAILED');
          throw ERR_ZLIB_INITIALIZATION_FAILED('Failed to load zstd dictionary');
        }
      }
      for (let i = 0; i < params.length; i++) {
        if (params[i] === 0xffffffff) continue;
        if (z.setParameter(this.state, i, params[i] | 0) < 0) {
          this.emitError('Setting parameter failed', -1, 'ERR_ZSTD_PARAM_SET_FAILED');
          throw ERR_ZLIB_INITIALIZATION_FAILED('Setting parameter failed');
        }
      }
    }

    reset() {
      // ResetStream: Init(ZSTD_CONTENTSIZE_UNKNOWN), a new context without
      // the dictionary and the parameters. An error stays.
      this.state = new (zstd().DCtx)();
    }

    doWork() {
      const s = this.state;
      const inEnd = this.inOff + this.inLen;
      const outEnd = this.outOff + this.outLen;
      const ret = zstd().decompressStream(s, this.out, this.outOff, outEnd, this.input, this.inOff, inEnd);
      if (ret < 0) {
        this.errorCode = -ret;
      } else {
        this.availIn = inEnd - s.inPos_;
        this.availOut = outEnd - s.outPos_;
      }
      this.input = null;
      this.out = null;
    }

    /** ZstdContext::GetErrorInfo */
    checkError() {
      if (this.errorCode !== 0) {
        const z = zstd();
        this.emitError(z.errorString(this.errorCode), this.errorCode, z.errorName(this.errorCode));
        return false;
      }
      return true;
    }
  }

  const toInt64 = (n) => (Number.isNaN(n) ? 0 : Math.max(-(2 ** 63), Math.min(2 ** 63 - 1, Math.trunc(n))));

  class ZstdCompressHandle extends ZstdHandle {
    init(params, pledgedSrcSize, writeResult, writeCallback, dictionary) {
      this.writeResult = writeResult;
      this.writeCallback = writeCallback;
      this.pledgedSrcSize = 2n ** 64n - 1n;
      if (typeof pledgedSrcSize === 'number') {
        const size = toInt64(pledgedSrcSize);
        if (size < 0) throw nativeError(TypeError, 'ERR_INVALID_ARG_VALUE', 'pledgedSrcSize may not be negative');
        this.pledgedSrcSize = BigInt(size);
      }
      const message = this.initContext(dictionary);
      if (message) throw ERR_ZLIB_INITIALIZATION_FAILED(message);
      for (let i = 0; i < params.length; i++) {
        if (params[i] === 0xffffffff) continue;
        if (this.state.setParameter(i, params[i]) !== 0) {
          this.emitError('Setting parameter failed', -1, 'ERR_ZSTD_PARAM_SET_FAILED');
          throw ERR_ZLIB_INITIALIZATION_FAILED('Setting parameter failed');
        }
      }
    }

    initContext(dictionary) {
      this.state?.destroy();
      const s = new (zstdCompress().CCtx)();
      this.state = s;
      let failure;
      if (!s.ok) failure = ['Could not initialize zstd instance', 'ERR_ZLIB_INITIALIZATION_FAILED'];
      else if (dictionary !== undefined && dictionary.byteLength !== 0 && s.loadDictionary(bytes(dictionary)) !== 0) {
        failure = ['Failed to load zstd dictionary', 'ERR_ZLIB_DICTIONARY_LOAD_FAILED'];
      } else if (s.setPledgedSrcSize(this.pledgedSrcSize) !== 0) {
        failure = ['Could not set pledged src size', 'ERR_ZLIB_INITIALIZATION_FAILED'];
      }
      if (!failure) return null;
      this.emitError(failure[0], -1, failure[1]);
      return failure[0];
    }

    reset() {
      this.initContext();
    }

    doWork() {
      const s = this.state;
      let error;
      try {
        error = s.compressStream2(this.flush, this.input, this.inOff, this.inLen, this.out, this.outOff, this.outLen);
      } catch (err) {
        if (!(err instanceof WebAssembly.RuntimeError)) throw err;
        error = 64;
      }
      if (error !== 0) this.errorCode = error;
      this.availIn = s.availIn;
      this.availOut = s.availOut;
      this.input = null;
      this.out = null;
    }
  }

  function zlibOnError(message, errno, code) {
    const self = this[owner];
    // There is no way to cleanly recover. Continuing only obscures problems.
    const error = Object.assign(new Error(message), { errno, code });
    error.errno = errno;
    error.code = code;
    self.destroy(error);
    self[kError] = error;
  }

  function _close(engine) {
    // Caller may invoke .close after a zlib error (which will null _handle).
    engine._handle?.close();
    engine._handle = null;
  }

  // The base class for all Zlib-style streams.
  function ZlibBase(opts, mode, handle, { flush, finishFlush, fullFlush }) {
    let chunkSize = Z_DEFAULT_CHUNK;
    let maxOutputLength = kMaxLength;
    const flushBound = mode === ZSTD_DECOMPRESS || mode === ZSTD_COMPRESS ? FLUSH_BOUND_ZSTD : FLUSH_BOUND_BROTLI;
    if (opts) {
      chunkSize = opts.chunkSize;
      if (!validateFiniteNumber(chunkSize, 'options.chunkSize')) {
        chunkSize = Z_DEFAULT_CHUNK;
      } else if (chunkSize < Z_MIN_CHUNK) {
        throw ERR_OUT_OF_RANGE('options.chunkSize', `>= ${Z_MIN_CHUNK}`, chunkSize);
      }
      flush = checkRangesOrGetDefault(opts.flush, 'options.flush', flushBound[0], flushBound[1], flush);
      finishFlush = checkRangesOrGetDefault(
        opts.finishFlush,
        'options.finishFlush',
        flushBound[0],
        flushBound[1],
        finishFlush
      );
      maxOutputLength = checkRangesOrGetDefault(
        opts.maxOutputLength,
        'options.maxOutputLength',
        1,
        kMaxLength,
        kMaxLength
      );
      if (opts.encoding || opts.objectMode || opts.writableObjectMode) {
        opts = { ...opts };
        opts.encoding = null;
        opts.objectMode = false;
        opts.writableObjectMode = false;
      }
    }
    Transform.call(this, { autoDestroy: true, ...opts });
    this[kError] = null;
    this.bytesWritten = 0;
    this._handle = handle;
    handle[owner] = this;
    // Used by processCallback() and zlibOnError()
    handle.onerror = zlibOnError;
    this._outBuffer = Buffer.allocUnsafe(chunkSize);
    this._outOffset = 0;
    this._chunkSize = chunkSize;
    this._defaultFlushFlag = flush;
    this._finishFlushFlag = finishFlush;
    this._defaultFullFlushFlag = fullFlush;
    this._info = opts?.info;
    this._maxOutputLength = maxOutputLength;
    this._rejectGarbageAfterEnd = opts?.rejectGarbageAfterEnd === true;
  }
  Object.setPrototypeOf(ZlibBase.prototype, Transform.prototype);
  Object.setPrototypeOf(ZlibBase, Transform);

  Object.defineProperty(ZlibBase.prototype, '_closed', {
    configurable: true,
    enumerable: true,
    get() {
      return !this._handle;
    },
  });

  Object.defineProperty(ZlibBase.prototype, 'bytesRead', {
    configurable: true,
    enumerable: true,
    get: util.deprecate(
      function () {
        return this.bytesWritten;
      },
      'zlib.bytesRead is deprecated and will change its meaning in the future. Use zlib.bytesWritten instead.',
      'DEP0108'
    ),
    set: util.deprecate(
      function (value) {
        this.bytesWritten = value;
      },
      'Setting zlib.bytesRead is deprecated. This feature will be removed in the future.',
      'DEP0108'
    ),
  });

  ZlibBase.prototype.reset = function () {
    if (!this._handle) {
      throw nodeError(
        Error,
        'ERR_INTERNAL_ASSERTION',
        'zlib binding closed\nThis is caused by either a bug in Node.js or incorrect usage of Node.js internals.\n' +
          'Please open an issue with this stack trace at https://github.com/nodejs/node/issues\n'
      );
    }
    return this._handle.reset();
  };

  // The _flush function called by the transform class when the last chunk
  // has been written.
  ZlibBase.prototype._flush = function (callback) {
    this._transform(Buffer.alloc(0), '', callback);
  };

  // Force Transform compat behavior.
  ZlibBase.prototype._final = function (callback) {
    callback();
  };

  ZlibBase.prototype.flush = function (kind, callback) {
    if (typeof kind === 'function' || (kind === undefined && !callback)) {
      callback = kind;
      kind = this._defaultFullFlushFlag;
    }
    if (this.writableFinished) {
      if (callback) process.nextTick(callback);
    } else if (this.writableEnded) {
      if (callback) this.once('end', callback);
    } else {
      this.write(kFlushBuffers[kind], '', callback);
    }
  };

  ZlibBase.prototype.close = function (callback) {
    if (callback) finished(this, callback);
    this.destroy();
  };

  ZlibBase.prototype._destroy = function (err, callback) {
    _close(this);
    callback(err);
  };

  ZlibBase.prototype._transform = function (chunk, encoding, cb) {
    let flushFlag = this._defaultFlushFlag;
    // A 'fake' zero-length chunk carries information about flushes from the
    // public API to the actual stream implementation.
    if (typeof chunk[kFlushFlag] === 'number') flushFlag = chunk[kFlushFlag];
    // For the last chunk, also apply `_finishFlushFlag`.
    if (this.writableEnded && this.writableLength === chunk.byteLength) {
      flushFlag = maxFlush(flushFlag, this._finishFlushFlag);
    }
    processChunk(this, chunk, flushFlag, cb);
  };

  ZlibBase.prototype._processChunk = function (chunk, flushFlag, cb) {
    // _processChunk() is left for backwards compatibility
    if (typeof cb === 'function') processChunk(this, chunk, flushFlag, cb);
    else return processChunkSync(this, chunk, flushFlag);
  };

  function processChunkSync(self, chunk, flushFlag) {
    let availInBefore = chunk.byteLength;
    let availOutBefore = self._chunkSize - self._outOffset;
    let inOff = 0;
    let availOutAfter;
    let availInAfter;
    const buffers = [];
    let nread = 0;
    let inputRead = 0;
    const state = self._writeState;
    const handle = self._handle;
    let buffer = self._outBuffer;
    let offset = self._outOffset;
    const chunkSize = self._chunkSize;
    let error;
    self.on('error', function onError(er) {
      error = er;
    });
    while (true) {
      handle.writeSync(flushFlag, chunk, inOff, availInBefore, buffer, offset, availOutBefore);
      if (error) throw error;
      else if (self[kError]) throw self[kError];
      availOutAfter = state[0];
      availInAfter = state[1];
      const inDelta = availInBefore - availInAfter;
      inputRead += inDelta;
      const have = availOutBefore - availOutAfter;
      if (have > 0) {
        const out = buffer.slice(offset, offset + have);
        offset += have;
        buffers.push(out);
        nread += out.byteLength;
        if (nread > self._maxOutputLength) {
          _close(self);
          throw ERR_BUFFER_TOO_LARGE(self._maxOutputLength);
        }
      }
      // Exhausted the output buffer, or used all the input: create a new one.
      if (availOutAfter === 0 || offset >= chunkSize) {
        availOutBefore = chunkSize;
        offset = 0;
        buffer = Buffer.allocUnsafe(chunkSize);
      }
      if (availOutAfter === 0) {
        // Not actually done. Need to reprocess.
        inOff += inDelta;
        availInBefore = availInAfter;
      } else {
        break;
      }
    }
    self.bytesWritten = inputRead;
    _close(self);
    if (nread === 0) return Buffer.alloc(0);
    return buffers.length === 1 ? buffers[0] : Buffer.concat(buffers, nread);
  }

  function processChunk(self, chunk, flushFlag, cb) {
    const handle = self._handle;
    if (!handle) return process.nextTick(cb);
    handle.buffer = chunk;
    handle.cb = cb;
    handle.availOutBefore = self._chunkSize - self._outOffset;
    handle.availInBefore = chunk.byteLength;
    handle.inOff = 0;
    handle.flushFlag = flushFlag;
    handle.write(flushFlag, chunk, 0, handle.availInBefore, self._outBuffer, self._outOffset, handle.availOutBefore);
  }

  function processCallback() {
    // This callback's context (`this`) is the `_handle` object.
    const handle = this;
    const self = this[owner];
    const state = self._writeState;
    if (self.destroyed) {
      this.buffer = null;
      this.cb();
      return;
    }
    const availOutAfter = state[0];
    const availInAfter = state[1];
    const inDelta = handle.availInBefore - availInAfter;
    self.bytesWritten += inDelta;
    const have = handle.availOutBefore - availOutAfter;
    let streamBufferIsFull = false;
    if (have > 0) {
      const out = self._outBuffer.slice(self._outOffset, self._outOffset + have);
      self._outOffset += have;
      streamBufferIsFull = !self.push(out);
    }
    if (self.destroyed) {
      this.cb();
      return;
    }
    // Exhausted the output buffer, or used all the input: create a new one.
    if (availOutAfter === 0 || self._outOffset >= self._chunkSize) {
      handle.availOutBefore = self._chunkSize;
      self._outOffset = 0;
      self._outBuffer = Buffer.allocUnsafe(self._chunkSize);
    }
    if (availOutAfter === 0) {
      // Not actually done. Need to reprocess.
      handle.inOff += inDelta;
      handle.availInBefore = availInAfter;
      if (!streamBufferIsFull) {
        this.write(
          handle.flushFlag,
          this.buffer,
          handle.inOff,
          handle.availInBefore,
          self._outBuffer,
          self._outOffset,
          self._chunkSize
        );
      } else {
        const oldRead = self._read;
        self._read = (n) => {
          self._read = oldRead;
          this.write(
            handle.flushFlag,
            this.buffer,
            handle.inOff,
            handle.availInBefore,
            self._outBuffer,
            self._outOffset,
            self._chunkSize
          );
          self._read(n);
        };
      }
      return;
    }
    if (availInAfter > 0) {
      // More input, but output space left: the stream has ended early.
      if (self._rejectGarbageAfterEnd) {
        const err = nodeError(TypeError, 'ERR_TRAILING_JUNK_AFTER_STREAM_END', 'Trailing junk found after the end of the compressed stream');
        self.destroy(err);
        this.cb(err);
        return;
      }
      self.push(null);
    }
    // Finished with the chunk.
    this.buffer = null;
    this.cb();
  }

  // Base class for all streams backed by zlib; Brotli's prototype chain
  // goes through it, for params().
  function Zlib() {}
  Object.setPrototypeOf(Zlib.prototype, ZlibBase.prototype);
  Object.setPrototypeOf(Zlib, ZlibBase);

  function paramsAfterFlushCallback(level, strategy, callback) {
    if (!this._handle) throw new Error('zlib binding closed');
    this._handle.params(level, strategy);
    if (!this.destroyed) {
      this._level = level;
      this._strategy = strategy;
      if (callback) callback();
    }
  }

  Zlib.prototype.params = function params(level, strategy, callback) {
    checkRangesOrGetDefault(level, 'level', Z_MIN_LEVEL, Z_MAX_LEVEL);
    checkRangesOrGetDefault(strategy, 'strategy', Z_DEFAULT_STRATEGY, Z_FIXED);
    if (this._level !== level || this._strategy !== strategy) {
      this.flush(Z_SYNC_FLUSH, paramsAfterFlushCallback.bind(this, level, strategy, callback));
    } else {
      process.nextTick(callback);
    }
  };

  const brotliDefaultOpts = {
    flush: BROTLI_OPERATION_PROCESS,
    finishFlush: BROTLI_OPERATION_FINISH,
    fullFlush: BROTLI_OPERATION_FLUSH,
  };

  function Brotli(opts, mode) {
    brotliInitParamsArray.fill(-1);
    if (opts?.params) {
      Object.keys(opts.params).forEach((origKey) => {
        const key = +origKey;
        if (Number.isNaN(key) || key < 0 || key > kMaxBrotliParam || (brotliInitParamsArray[key] | 0) !== -1) {
          throw ERR_BROTLI_INVALID_PARAM(origKey);
        }
        const value = opts.params[origKey];
        if (typeof value !== 'number' && typeof value !== 'boolean') {
          throw ERR_INVALID_ARG_TYPE('options.params[key]', 'number', opts.params[origKey]);
        }
        brotliInitParamsArray[key] = value;
      });
    }
    const handle = mode === BROTLI_ENCODE ? new BrotliEncoderHandle() : new BrotliHandle(mode);
    this._writeState = new Uint32Array(2);
    handle.init(brotliInitParamsArray, this._writeState, processCallback);
    ZlibBase.call(this, opts, mode, handle, brotliDefaultOpts);
  }
  Object.setPrototypeOf(Brotli.prototype, Zlib.prototype);
  Object.setPrototypeOf(Brotli, Zlib);

  function BrotliCompress(opts) {
    if (!(this instanceof BrotliCompress)) return new BrotliCompress(opts);
    Brotli.call(this, opts, BROTLI_ENCODE);
  }
  Object.setPrototypeOf(BrotliCompress.prototype, Brotli.prototype);
  Object.setPrototypeOf(BrotliCompress, Brotli);

  function BrotliDecompress(opts) {
    if (!(this instanceof BrotliDecompress)) return new BrotliDecompress(opts);
    Brotli.call(this, opts, BROTLI_DECODE);
  }
  Object.setPrototypeOf(BrotliDecompress.prototype, Brotli.prototype);
  Object.setPrototypeOf(BrotliDecompress, Brotli);

  const zstdDefaultOpts = {
    flush: ZSTD_e_continue,
    finishFlush: ZSTD_e_end,
    fullFlush: ZSTD_e_flush,
  };

  class Zstd extends ZlibBase {
    constructor(opts, mode, initParamsArray, maxParam) {
      initParamsArray.fill(-1);
      if (opts?.params) {
        Object.keys(opts.params).forEach((origKey) => {
          const key = +origKey;
          if (Number.isNaN(key) || key < 0 || key > maxParam || (initParamsArray[key] | 0) !== -1) {
            throw ERR_ZSTD_INVALID_PARAM(origKey);
          }
          const value = opts.params[origKey];
          if (typeof value !== 'number' && typeof value !== 'boolean') {
            throw ERR_INVALID_ARG_TYPE('options.params[key]', 'number', opts.params[origKey]);
          }
          initParamsArray[key] = value;
        });
      }
      const handle = mode === ZSTD_COMPRESS ? new ZstdCompressHandle() : new ZstdHandle();
      const pledgedSrcSize = opts?.pledgedSrcSize ?? undefined;
      const writeState = new Uint32Array(2);
      handle.init(
        initParamsArray,
        pledgedSrcSize,
        writeState,
        processCallback,
        opts?.dictionary && ArrayBuffer.isView(opts.dictionary) ? opts.dictionary : undefined
      );
      super(opts, mode, handle, zstdDefaultOpts);
      this._writeState = writeState;
    }
  }

  class ZstdCompress extends Zstd {
    constructor(opts) {
      super(opts, ZSTD_COMPRESS, zstdInitCParamsArray, kMaxZstdCParam);
    }
  }

  class ZstdDecompress extends Zstd {
    constructor(opts) {
      super(opts, ZSTD_DECOMPRESS, zstdInitDParamsArray, kMaxZstdDParam);
    }
  }

  function zlibBuffer(engine, buffer, callback) {
    validateFunction(callback, 'callback');
    // Streams do not support non-Uint8Array ArrayBufferViews yet. Convert it
    // to a Buffer without copying.
    if (ArrayBuffer.isView(buffer) && !(buffer instanceof Uint8Array)) {
      buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else if (isAnyArrayBuffer(buffer)) {
      buffer = Buffer.from(buffer);
    }
    engine.buffers = null;
    engine.nread = 0;
    engine.cb = callback;
    engine.on('data', zlibBufferOnData);
    engine.on('error', zlibBufferOnError);
    engine.on('end', zlibBufferOnEnd);
    engine.end(buffer);
  }

  function zlibBufferOnData(chunk) {
    if (!this.buffers) this.buffers = [chunk];
    else this.buffers.push(chunk);
    this.nread += chunk.length;
    if (this.nread > this._maxOutputLength) {
      this.close();
      this.removeAllListeners('end');
      this.cb(ERR_BUFFER_TOO_LARGE(this._maxOutputLength));
    }
  }

  function zlibBufferOnError(err) {
    this.removeAllListeners('end');
    this.cb(err);
  }

  function zlibBufferOnEnd() {
    let buf;
    if (this.nread === 0) {
      buf = Buffer.alloc(0);
    } else {
      const bufs = this.buffers;
      buf = bufs.length === 1 ? bufs[0] : Buffer.concat(bufs, this.nread);
    }
    this.close();
    if (this._info) this.cb(null, { buffer: buf, engine: this });
    else this.cb(null, buf);
  }

  function zlibBufferSync(engine, buffer) {
    if (typeof buffer === 'string') {
      buffer = Buffer.from(buffer);
    } else if (!ArrayBuffer.isView(buffer)) {
      if (isAnyArrayBuffer(buffer)) {
        buffer = Buffer.from(buffer);
      } else {
        throw ERR_INVALID_ARG_TYPE('buffer', ['string', 'Buffer', 'TypedArray', 'DataView', 'ArrayBuffer'], buffer);
      }
    }
    buffer = processChunkSync(engine, buffer, engine._finishFlushFlag);
    if (engine._info) return { buffer, engine };
    return buffer;
  }

  function createConvenienceMethod(ctor, sync) {
    if (sync) {
      return function syncBufferWrapper(buffer, opts) {
        return zlibBufferSync(new ctor(opts), buffer);
      };
    }
    return function asyncBufferWrapper(buffer, opts, callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      return zlibBuffer(new ctor(opts), buffer, callback);
    };
  }

  // The factories are the descriptors' `value` functions, named so in Node.
  function createProperty(ctor) {
    return {
      value: function (options) {
        return new ctor(options);
      },
    }.value;
  }

  return {
    BrotliCompress,
    brotliCompress: createConvenienceMethod(BrotliCompress, false),
    brotliCompressSync: createConvenienceMethod(BrotliCompress, true),
    createBrotliCompress: createProperty(BrotliCompress),
    BrotliDecompress,
    brotliDecompress: createConvenienceMethod(BrotliDecompress, false),
    brotliDecompressSync: createConvenienceMethod(BrotliDecompress, true),
    createBrotliDecompress: createProperty(BrotliDecompress),
    ZstdCompress,
    zstdCompress: createConvenienceMethod(ZstdCompress, false),
    zstdCompressSync: createConvenienceMethod(ZstdCompress, true),
    createZstdCompress: createProperty(ZstdCompress),
    ZstdDecompress,
    zstdDecompress: createConvenienceMethod(ZstdDecompress, false),
    zstdDecompressSync: createConvenienceMethod(ZstdDecompress, true),
    createZstdDecompress: createProperty(ZstdDecompress),
  };
}
