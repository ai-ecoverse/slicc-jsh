import { ERR_MISSING_ARGS, nodeError, validateFunction, validateUint32 } from '../node-errors.mjs';
import { queueMicrotask } from '../async-context.mjs';

const ERR_DIR_CLOSED = () => nodeError(Error, 'ERR_DIR_CLOSED', 'Directory handle was closed');

export class Dir {
  #entries;
  #path;
  #closed = false;

  constructor(handle, path, options) {
    if (handle == null) throw ERR_MISSING_ARGS('handle');
    validateUint32(options?.bufferSize ?? 32, 'options.bufferSize', true);
    this.#entries = handle.entries;
    this.#path = path;
  }

  get path() {
    if (!(#path in this)) throw nodeError(TypeError, 'ERR_INVALID_THIS', 'Value of "this" must be of type Dir');
    return this.#path;
  }

  #next() {
    return this.#entries.length ? this.#entries.shift() : null;
  }

  read(callback) {
    if (arguments.length === 0) return this.#readPromise();
    if (this.#closed) throw ERR_DIR_CLOSED();
    if (callback === undefined) return this.#readPromise();
    validateFunction(callback, 'callback');
    const entry = this.#next();
    queueMicrotask(() => callback(null, entry));
    return undefined;
  }

  #readPromise() {
    if (this.#closed) return Promise.reject(ERR_DIR_CLOSED());
    return Promise.resolve(this.#next());
  }

  readSync() {
    if (this.#closed) throw ERR_DIR_CLOSED();
    return this.#next();
  }

  close(callback) {
    if (callback === undefined) {
      if (this.#closed) return Promise.reject(ERR_DIR_CLOSED());
      this.#closed = true;
      return Promise.resolve();
    }
    validateFunction(callback, 'callback');
    const err = this.#closed ? ERR_DIR_CLOSED() : null;
    this.#closed = true;
    queueMicrotask(() => callback(err));
    return undefined;
  }

  closeSync() {
    if (this.#closed) throw ERR_DIR_CLOSED();
    this.#closed = true;
  }

  async *entries() {
    try {
      for (;;) {
        const result = await this.#readPromise();
        if (result === null) break;
        yield result;
      }
    } finally {
      await this.close();
    }
  }

  [Symbol.dispose]() {
    if (this.#closed) return;
    this.closeSync();
  }

  async [Symbol.asyncDispose]() {
    if (this.#closed) return;
    await this.close();
  }
}

Object.defineProperty(Dir.prototype, Symbol.asyncIterator, {
  enumerable: false,
  writable: true,
  configurable: true,
  value: Dir.prototype.entries,
});
