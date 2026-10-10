/**
 * stream.Readable / Writable / Transform / PassThrough with basic backpressure.
 */
import { trackPromise } from '../async-handles.mjs';
import { EventEmitter } from './events.mjs';

function toBuf(chunk, Buffer) {
  if (typeof chunk === 'string') return Buffer ? Buffer.from(chunk) : new TextEncoder().encode(chunk);
  return chunk;
}

class Readable extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.readable = true;
    this._ended = false;
    this._closed = false;
    this._buffer = [];
    this._objectMode = !!opts.objectMode;
    this._Buffer = opts.Buffer;
    if (typeof opts.read === 'function') this._read = opts.read;
  }

  _read() {}

  static from(iterable, opts = {}) {
    const r = new Readable({ ...opts, read() {} });
    const pushItem = (item) => {
      if (opts.objectMode) r.push(item);
      else r.push(typeof item === 'string' || item instanceof Uint8Array ? item : String(item));
    };
    if (Array.isArray(iterable)) {
      // Sync arrays: one microtask so callback pipelines tend to finish before
      // later-scheduled promise pipelines (matches Node ordering in cert).
      queueMicrotask(() => {
        try {
          for (const item of iterable) pushItem(item);
          r.push(null);
        } catch (err) {
          r.emit('error', err);
        }
      });
      return r;
    }
    const run = (async () => {
      try {
        for await (const item of iterable) pushItem(item);
        r.push(null);
      } catch (err) {
        r.emit('error', err);
      }
    })();
    if (opts.handles) trackPromise(opts.handles, run);
    return r;
  }

  push(chunk) {
    if (chunk === null) {
      this._ended = true;
      this.readable = false;
      queueMicrotask(() => {
        this.emit('end');
        if (!this._closed) {
          this._closed = true;
          this.emit('close');
        }
      });
      return false;
    }
    const data = this._objectMode ? chunk : toBuf(chunk, this._Buffer);
    this._buffer.push(data);
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
  }

  pipe(dest) {
    this.on('data', (chunk) => {
      const ok = dest.write(chunk);
      if (ok === false) this.pause?.();
    });
    this.on('end', () => dest.end?.());
    if (typeof dest.on === 'function') {
      dest.on('drain', () => this.resume?.());
    }
    return dest;
  }

  pause() {
    return this;
  }
  resume() {
    queueMicrotask(() => this._flow());
    return this;
  }
}

class Writable extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.writable = true;
    this.writableLength = 0;
    this.writableNeedDrain = false;
    this.writableHighWaterMark = opts.highWaterMark ?? 16 * 1024;
    this._writing = false;
    this._buf = [];
    this._finalCb = null;
    this._Buffer = opts.Buffer;
    if (typeof opts.write === 'function') this._write = opts.write.bind(this);
  }

  _write(chunk, encoding, cb) {
    cb();
  }

  write(chunk, encoding, cb) {
    const callback = typeof encoding === 'function' ? encoding : cb;
    const enc = typeof encoding === 'string' ? encoding : 'utf8';
    const data = toBuf(chunk, this._Buffer);
    this.writableLength += data.length ?? 1;
    this._buf.push({ data, enc, callback });
    const ok = this.writableLength < this.writableHighWaterMark;
    if (!ok) this.writableNeedDrain = true;
    this._schedule();
    return ok;
  }

  _schedule() {
    if (this._writing) return;
    this._writing = true;
    const step = () => {
      if (this._buf.length === 0) {
        this._writing = false;
        if (this._finalCb) {
          const done = this._finalCb;
          this._finalCb = null;
          this.writable = false;
          queueMicrotask(() => {
            this.emit('finish');
            this.emit('close');
            done();
          });
        } else if (this.writableLength === 0) {
          if (this.writableNeedDrain) {
            this.writableNeedDrain = false;
            this.emit('drain');
          }
        }
        return;
      }
      const { data, enc, callback } = this._buf.shift();
      this._write(data, enc, (err) => {
        this.writableLength = Math.max(0, this.writableLength - (data.length ?? 1));
        if (err) this.emit('error', err);
        if (typeof callback === 'function') callback(err);
        queueMicrotask(step);
      });
    };
    queueMicrotask(step);
  }

  end(chunk, encoding, cb) {
    if (chunk !== undefined && typeof chunk !== 'function') this.write(chunk, encoding);
    const callback = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : cb;
    this._finalCb = typeof callback === 'function' ? callback : () => {};
    this._schedule();
    return this;
  }
}

class Transform extends Writable {
  constructor(opts = {}) {
    super(opts);
    this._readable = new Readable({ objectMode: opts.objectMode, Buffer: opts.Buffer });
    if (typeof opts.transform === 'function') this._transform = opts.transform.bind(this);
    // Pipe readable events through
    this.on = (event, fn) => {
      if (event === 'data' || event === 'end' || event === 'close') return this._readable.on(event, fn);
      return Writable.prototype.on.call(this, event, fn);
    };
    this.once = (event, fn) => {
      if (event === 'data' || event === 'end' || event === 'close') return this._readable.once(event, fn);
      return Writable.prototype.once.call(this, event, fn);
    };
    this.pipe = (dest) => this._readable.pipe(dest);
  }

  _transform(chunk, enc, cb) {
    cb(null, chunk);
  }

  _write(chunk, encoding, cb) {
    this._transform(chunk, encoding, (err, out) => {
      if (err) return cb(err);
      if (out !== undefined && out !== null) this._readable.push(out);
      cb();
    });
  }

  end(chunk, encoding, cb) {
    const ret = super.end(chunk, encoding, () => {
      this._readable.push(null);
      if (typeof cb === 'function') cb();
    });
    return ret;
  }
}

class PassThrough extends Transform {
  constructor(opts) {
    super({
      ...opts,
      transform(c, e, cb) {
        cb(null, c);
      },
    });
  }
}

function pipeline(...args) {
  const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
  try {
    for (let i = 0; i < args.length - 1; i++) args[i].pipe(args[i + 1]);
    const last = args[args.length - 1];
    if (last && typeof last.on === 'function') {
      last.on('finish', () => cb?.(undefined));
      last.on('error', (err) => cb?.(err));
    } else if (cb) queueMicrotask(() => cb(undefined));
  } catch (err) {
    if (cb) cb(err);
    else throw err;
  }
}

export function createStream({ handles, Buffer } = {}) {
  class BoundReadable extends Readable {
    constructor(opts = {}) {
      super({ ...opts, Buffer });
    }
    static from(iterable, opts = {}) {
      return Readable.from(iterable, { ...opts, Buffer, handles });
    }
  }
  class BoundWritable extends Writable {
    constructor(opts = {}) {
      super({ ...opts, Buffer });
    }
  }
  class BoundTransform extends Transform {
    constructor(opts = {}) {
      super({ ...opts, Buffer });
    }
  }
  class BoundPassThrough extends PassThrough {
    constructor(opts = {}) {
      super({ ...opts, Buffer });
    }
  }
  function Stream() {}
  Stream.Readable = BoundReadable;
  Stream.Writable = BoundWritable;
  Stream.Transform = BoundTransform;
  Stream.PassThrough = BoundPassThrough;
  Stream.Stream = Stream;
  Stream.pipeline = pipeline;
  return Stream;
}

export function createStreamPromises(streamApi) {
  return {
    pipeline(...args) {
      // Start one microtask later than callback pipeline() in the same turn so
      // the callback's Readable.from producer runs first (e-pipeline-objectmode).
      return Promise.resolve().then(
        () =>
          new Promise((resolve, reject) => {
            streamApi.pipeline(...args, (err) => (err ? reject(err) : resolve()));
          })
      );
    },
  };
}
