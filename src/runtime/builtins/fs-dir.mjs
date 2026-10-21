import { ERR_MISSING_ARGS, nodeError, validateFunction, validateUint32 } from '../node-errors.mjs';
import { queueMicrotask } from '../async-context.mjs';

const ERR_DIR_CLOSED = () => nodeError(Error, 'ERR_DIR_CLOSED', 'Directory handle was closed');
const ERR_DIR_CONCURRENT_OPERATION = () =>
  nodeError(Error, 'ERR_DIR_CONCURRENT_OPERATION', 'Cannot do synchronous work on directory handle with concurrent asynchronous operations');

export class Dir {
  #entries;
  #path;
  #bufferSize;
  #buffered = [];
  #closed = false;
  #operationQueue = null;

  constructor(handle, path, options) {
    if (handle == null) throw ERR_MISSING_ARGS('handle');
    this.#bufferSize = options?.bufferSize ?? 32;
    validateUint32(this.#bufferSize, 'options.bufferSize', true);
    this.#entries = handle.entries;
    this.#path = path;
  }

  get path() {
    if (!(#path in this)) throw nodeError(TypeError, 'ERR_INVALID_THIS', 'Value of "this" must be of type Dir');
    return this.#path;
  }

  #fill() {
    this.#buffered.push(...this.#entries.splice(0, this.#bufferSize));
    return this.#buffered.length > 0;
  }

  read(callback) {
    return arguments.length === 0 ? this.#readPromise() : this.#readImpl(callback);
  }

  #readPromise() {
    return new Promise((resolve, reject) => this.#readImpl((err, entry) => (err ? reject(err) : resolve(entry))));
  }

  #readImpl(callback) {
    if (this.#closed) throw ERR_DIR_CLOSED();
    if (callback === undefined) return this.#readPromise();
    validateFunction(callback, 'callback');
    if (this.#operationQueue !== null) {
      this.#operationQueue.push(() => this.#readImpl(callback));
      return undefined;
    }
    if (this.#buffered.length > 0) {
      const entry = this.#buffered.shift();
      queueMicrotask(() => callback(null, entry));
      return undefined;
    }
    this.#operationQueue = [];
    queueMicrotask(() => {
      queueMicrotask(() => {
        const queue = this.#operationQueue;
        this.#operationQueue = null;
        for (const op of queue) op();
      });
      callback(null, this.#fill() ? this.#buffered.shift() : null);
    });
    return undefined;
  }

  readSync() {
    if (this.#closed) throw ERR_DIR_CLOSED();
    if (this.#operationQueue !== null) throw ERR_DIR_CONCURRENT_OPERATION();
    return this.#buffered.length > 0 || this.#fill() ? this.#buffered.shift() : null;
  }

  close(callback) {
    if (callback === undefined) {
      if (this.#closed) return Promise.reject(ERR_DIR_CLOSED());
      return new Promise((resolve, reject) => this.close((err) => (err ? reject(err) : resolve())));
    }
    validateFunction(callback, 'callback');
    if (this.#closed) {
      queueMicrotask(() => callback(ERR_DIR_CLOSED()));
      return undefined;
    }
    if (this.#operationQueue !== null) {
      this.#operationQueue.push(() => this.close(callback));
      return undefined;
    }
    this.#closed = true;
    queueMicrotask(() => callback(null));
    return undefined;
  }

  closeSync() {
    if (this.#closed) throw ERR_DIR_CLOSED();
    if (this.#operationQueue !== null) throw ERR_DIR_CONCURRENT_OPERATION();
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
