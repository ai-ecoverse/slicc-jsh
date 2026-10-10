/**
 * Minimal stream.Readable / Writable for M1 smoke tests.
 * Full readable-stream lands when more of the API is needed.
 */
import { EventEmitter } from './events.mjs';

class Readable extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.readable = true;
    this._reading = false;
    this._ended = false;
    this._buffer = [];
    this._objectMode = !!opts.objectMode;
    if (typeof opts.read === 'function') this._read = opts.read;
  }

  _read() {}

  push(chunk) {
    if (chunk === null) {
      this._ended = true;
      this.readable = false;
      queueMicrotask(() => this.emit('end'));
      return false;
    }
    this._buffer.push(chunk);
    queueMicrotask(() => {
      if (this.listenerCount('data')) this._flow();
    });
    return true;
  }

  read() {
    if (this._buffer.length === 0) return null;
    return this._buffer.shift();
  }

  on(event, fn) {
    super.on(event, fn);
    if (event === 'data') queueMicrotask(() => this._flow());
    return this;
  }

  _flow() {
    while (this._buffer.length) {
      const chunk = this._buffer.shift();
      this.emit('data', chunk);
    }
    if (this._ended) this.emit('end');
  }

  pipe(dest) {
    this.on('data', (chunk) => dest.write(chunk));
    this.on('end', () => dest.end?.());
    return dest;
  }
}

class Writable extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.writable = true;
    this._chunks = [];
    if (typeof opts.write === 'function') this._write = opts.write;
  }

  _write(chunk, encoding, cb) {
    this._chunks.push(chunk);
    cb();
  }

  write(chunk, encoding, cb) {
    const callback = typeof encoding === 'function' ? encoding : cb;
    this._write(chunk, typeof encoding === 'string' ? encoding : 'utf8', (err) => {
      if (err) this.emit('error', err);
      if (typeof callback === 'function') callback(err);
    });
    return true;
  }

  end(chunk, encoding, cb) {
    if (chunk !== undefined && typeof chunk !== 'function') this.write(chunk, encoding);
    const callback = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : cb;
    this.writable = false;
    queueMicrotask(() => {
      this.emit('finish');
      if (typeof callback === 'function') callback();
    });
    return this;
  }
}

function Stream() {}
Stream.Readable = Readable;
Stream.Writable = Writable;
Stream.Stream = Stream;
Stream.PassThrough = class PassThrough extends Readable {
  constructor(opts) {
    super(opts);
    this._write = (chunk, enc, cb) => {
      this.push(chunk);
      cb();
    };
  }
  write(chunk, encoding, cb) {
    return Writable.prototype.write.call(this, chunk, encoding, cb);
  }
  end(chunk, encoding, cb) {
    if (chunk !== undefined && typeof chunk !== 'function') this.write(chunk, encoding);
    this.push(null);
    const callback = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : cb;
    if (typeof callback === 'function') queueMicrotask(callback);
    return this;
  }
};
Stream.pipeline = (...args) => {
  const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
  try {
    for (let i = 0; i < args.length - 1; i++) args[i].pipe(args[i + 1]);
    if (cb) queueMicrotask(() => cb());
  } catch (err) {
    if (cb) cb(err);
    else throw err;
  }
};

export function createStream() {
  return Stream;
}
