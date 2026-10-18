/**
 * zlib's Brotli decompression: Node 22.22.0's ZlibBase, Brotli and
 * BrotliDecompress (lib/zlib.js) and the convenience methods, over the
 * Brotli decoder in src/brotli (Google's C decoder ported to JavaScript;
 * dist/vendor/brotli.cjs, evaluated on first use). BrotliHandle stands in
 * for the native binding.BrotliDecoder (src/node_zlib.cc): an async write
 * runs, as on Node's thread pool, after the current turn of the loop.
 */
import { ZLIB_CONSTANTS } from './zlib-constants.mjs';
import { ERR_INVALID_ARG_TYPE, ERR_OUT_OF_RANGE, nativeError, nodeError, validateFunction, validateNumber } from '../node-errors.mjs';

const {
  BROTLI_DECODE,
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

const ERR_BUFFER_TOO_LARGE = (max) =>
  nodeError(RangeError, 'ERR_BUFFER_TOO_LARGE', `Cannot create a Buffer larger than ${max} bytes`);
const ERR_BROTLI_INVALID_PARAM = (value) =>
  nodeError(RangeError, 'ERR_BROTLI_INVALID_PARAM', `${value} is not a valid Brotli parameter`);

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

/** The decoder module (src/brotli/decode.mjs) and the stream classes, given the runtime. */
export function createBrotli({ Buffer, getStream, process, util, setImmediate, loadDecoder }) {
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

  let decoderModule;
  const decoder = () => (decoderModule ??= loadDecoder());

  /** binding.BrotliDecoder: the native handle (CompressionStream<BrotliDecoderContext>). */
  class BrotliHandle {
    constructor(mode) {
      this.mode = mode;
      this.state = null;
      this.writeResult = null;
      this.writeCallback = null;
      this.writeInProgress = false;
      this.pendingClose = false;
      this.closed = false;
      this.flush = BROTLI_OPERATION_PROCESS;
      this.lastResult = 1;
      this.errorCode = 0;
    }

    init(params, writeResult, writeCallback) {
      this.writeResult = writeResult;
      this.writeCallback = writeCallback;
      this.state = new (decoder().BrotliDecoder)();
      for (let i = 0; i < params.length; i++) {
        if (params[i] === 0xffffffff) continue;
        if (!this.state.setParameter(i, params[i])) {
          this.emitError('Setting parameter failed', -1, 'ERR_BROTLI_PARAM_SET_FAILED');
          throw nativeError(Error, 'ERR_ZLIB_INITIALIZATION_FAILED', 'Initialization failed');
        }
      }
    }

    // Currently a no-op, as in Node.
    params() {}

    reset() {
      // ResetStream: a new decoder, without the parameters init set.
      this.state = new (decoder().BrotliDecoder)();
      this.lastResult = 1;
      this.errorCode = 0;
    }

    close() {
      if (this.writeInProgress) {
        this.pendingClose = true;
        return;
      }
      this.pendingClose = false;
      this.closed = true;
      this.state = null;
    }

    write(flush, input, inOff, inLen, out, outOff, outLen) {
      this.start(flush, input, inOff, inLen, out, outOff, outLen);
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
      const bytes = (view) => (view ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength) : new Uint8Array(0));
      this.input = bytes(input);
      this.inOff = input ? inOff : 0;
      this.inLen = input ? inLen : 0;
      this.out = bytes(out);
      this.outOff = outOff;
      this.outLen = outLen;
      this.flush = flush;
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

    afterWork() {
      this.writeInProgress = false;
      this.doWork();
      if (!this.checkError()) return;
      this.updateWriteResult();
      this.writeCallback.call(this);
      if (this.pendingClose) this.close();
    }

    updateWriteResult() {
      this.writeResult[0] = this.availOut;
      this.writeResult[1] = this.availIn;
    }

    /** BrotliDecoderContext::GetErrorInfo. */
    checkError() {
      if (this.errorCode !== 0) {
        this.emitError('Decompression failed', this.errorCode, `ERR_${decoder().errorString(this.errorCode)}`);
        return false;
      }
      if (this.flush === BROTLI_OPERATION_FINISH && this.lastResult === 2) {
        // Match zlib's behaviour, as brotli doesn't have its own code for this.
        this.emitError('unexpected end of file', Z_BUF_ERROR, 'Z_BUF_ERROR');
        return false;
      }
      return true;
    }

    emitError(message, errno, code) {
      if (typeof this.onerror === 'function') this.onerror(message, errno, code);
      // No hope of rescue.
      this.writeInProgress = false;
      if (this.pendingClose) this.close();
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
    if (opts) {
      chunkSize = opts.chunkSize;
      if (!validateFiniteNumber(chunkSize, 'options.chunkSize')) {
        chunkSize = Z_DEFAULT_CHUNK;
      } else if (chunkSize < Z_MIN_CHUNK) {
        throw ERR_OUT_OF_RANGE('options.chunkSize', `>= ${Z_MIN_CHUNK}`, chunkSize);
      }
      flush = checkRangesOrGetDefault(
        opts.flush,
        'options.flush',
        BROTLI_OPERATION_PROCESS,
        BROTLI_OPERATION_EMIT_METADATA,
        flush
      );
      finishFlush = checkRangesOrGetDefault(
        opts.finishFlush,
        'options.finishFlush',
        BROTLI_OPERATION_PROCESS,
        BROTLI_OPERATION_EMIT_METADATA,
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
    if (!this._handle) throw new Error('zlib binding closed');
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
    const handle = new BrotliHandle(mode);
    this._writeState = new Uint32Array(2);
    handle.init(brotliInitParamsArray, this._writeState, processCallback);
    ZlibBase.call(this, opts, mode, handle, brotliDefaultOpts);
  }
  Object.setPrototypeOf(Brotli.prototype, Zlib.prototype);
  Object.setPrototypeOf(Brotli, Zlib);

  function BrotliDecompress(opts) {
    if (!(this instanceof BrotliDecompress)) return new BrotliDecompress(opts);
    Brotli.call(this, opts, BROTLI_DECODE);
  }
  Object.setPrototypeOf(BrotliDecompress.prototype, Brotli.prototype);
  Object.setPrototypeOf(BrotliDecompress, Brotli);

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

  return {
    BrotliDecompress,
    brotliDecompress: createConvenienceMethod(BrotliDecompress, false),
    brotliDecompressSync: createConvenienceMethod(BrotliDecompress, true),
    createBrotliDecompress: function (options) {
      return new BrotliDecompress(options);
    },
  };
}
