/**
 * fs.watch, its FSWatcher, and fs.promises.watch, as Node 22.22.0's lib/fs.js,
 * lib/internal/fs/watchers.js, lib/internal/fs/recursive_watch.js and
 * lib/internal/fs/promises.js have them on Linux, over the kernel's
 * file-change events (ctx.sync.fs.watch, slicc-kernel 1.125.0,
 * ai-ecoverse/slicc-kernel#1047).
 *
 * The binding's FSEvent handle is a kernel watch, and its events are the ones
 * libuv's inotify backend gives (deps/uv/src/unix/linux.c):
 *  - a change to an entry is 'change' (IN_MODIFY, IN_ATTRIB), anything else is
 *    'rename' (IN_CREATE, IN_DELETE, IN_MOVED_FROM, IN_MOVED_TO);
 *  - inotify keeps one of two equal events in a row that nobody has read yet,
 *    so the same event twice, before the program has had them, is one;
 *  - a watched file that goes gives 'change' (its link count, IN_ATTRIB),
 *    'rename' (IN_DELETE_SELF) and 'rename' again (IN_IGNORED); a watched
 *    directory gives 'rename' twice. The watcher stays open, and silent.
 *
 * `recursive` on Linux is Node's own JS watcher (recursive_watch.js): a
 * watch on each file and directory in the tree, ported here unchanged.
 */
import { EventEmitter } from './events.mjs';
import {
  AbortError,
  ERR_INVALID_ARG_VALUE,
  nodeError,
  validateAbortSignal,
  validateBoolean,
  validateInteger,
  validateObject,
  validateOneOf,
} from '../node-errors.mjs';

const kFSWatchStart = Symbol('kFSWatchStart');
const kEmptyObject = Object.freeze({ __proto__: null });

/**
 * Node's abort listeners for watchers resist stopImmediatePropagation()
 * (kResistStopPropagation); the platform's AbortSignal has no such option,
 * but a signal that follows it (AbortSignal.any) aborts whatever its
 * listeners do. Returns the listener's removal.
 */
function onAbort(signal, listener) {
  let target = signal;
  try {
    target = AbortSignal.any([signal]);
  } catch {
    /* not the platform's AbortSignal: its own listeners it is */
  }
  target.addEventListener('abort', listener, { once: true });
  return () => target.removeEventListener('abort', listener);
}

const ERR_FS_WATCH_QUEUE_OVERFLOW = (max) =>
  nodeError(Error, 'ERR_FS_WATCH_QUEUE_OVERFLOW', `fs.watch() queued more than ${max} events`);

/**
 * @param {object} o
 * @param {(path: string, options: object, onNote: Function) => { close(): void }} o.watch ctx.sync.fs.watch
 * @param {() => Promise<unknown>} o.barrier an async kernel call: answered after anything asked before it
 * @param {(path: string) => object} o.stat Stats for a path; throws with `code`
 * @param {(code: string) => number} o.errno the negative libuv errno for a code
 * @param {(errno: number, syscall: string, path: unknown) => Error} o.uvException Node's UVException
 * @param {(value: unknown, name: string) => string | Uint8Array} o.validatedPath getValidatedPath
 * @param {(options: unknown) => object} o.getOptions lib/internal/fs/utils.js getOptions
 * @param {() => object} o.fs the fs module (the recursive watcher calls its watch, statSync, readdirSync)
 * @param {Function} o.StatWatcher fs.watchFile's StatWatcher
 */
export function createFsWatch({ process, path, Buffer, handles, timers, watch: kernelWatch, barrier, stat, errno, uvException, validatedPath, getOptions, fs, StatWatcher }) {
  const isEncoding = (enc) => typeof enc === 'string' && Buffer.isEncoding(enc);
  /** A path argument as the kernel takes it: a string, absolute. */
  const target = (p) => path.resolve(typeof p === 'string' ? p : Buffer.from(p).toString());
  /** A filename as Node's FSEventWrap hands it out, in the watcher's encoding. */
  const encode = (name, encoding) => {
    if (encoding === 'buffer') return Buffer.from(name);
    if (!encoding || !isEncoding(encoding) || /^utf-?8$/i.test(encoding)) return name;
    return Buffer.from(name).toString(encoding);
  };

  /** The binding's FSEvent: a kernel watch, ref'd while it is persistent. */
  class FSEvent {
    #watch = null;
    #base = '';
    #file = false;
    #encoding = 'utf8';
    #refed = true;
    #closed = false;
    // Events not yet handed to onchange: what inotify still has unread.
    #queue = [];
    #flush = false;
    #entry = { kind: 'FSEventWrap' };
    initialized = false;

    start(filename, persistent, recursive, encoding) {
      if (this.#closed) return 0;
      const at = target(filename);
      this.#base = path.basename(at);
      this.#encoding = encoding;
      try {
        this.#watch = kernelWatch(at, {}, (note) => this.#note(note));
      } catch (err) {
        return errno(err?.code);
      }
      try {
        this.#file = !stat(at).isDirectory();
      } catch {
        /* gone already: the watch says so */
      }
      this.initialized = true;
      if (persistent !== true) this.#refed = false;
      if (this.#refed) handles?.add(this.#entry);
      return 0;
    }

    #note(note) {
      if (this.#closed || note.overflow) return;
      if (note.ended) {
        // IN_IGNORED, after the IN_DELETE_SELF the watch's own name was.
        this.#push('rename', this.#base, true);
      } else if (note.moved) this.#push('rename', this.#base, true);
      else if (this.#file && note.type === 'rename') {
        // The link count, then IN_DELETE_SELF.
        this.#push('change', this.#base, true);
        this.#push('rename', this.#base, true);
      } else this.#push(note.type, note.filename, false);
    }

    #push(eventType, filename, own) {
      const last = this.#queue.at(-1);
      // inotify merges an event with the one before it while both are unread.
      if (!own && last && !last.own && last.eventType === eventType && last.filename === filename) return;
      this.#queue.push({ eventType, filename, own });
      if (this.#flush) return;
      // The kernel hands out what it has queued one batch at a time, and one
      // operation can queue several notes: a turn later, and after a round
      // trip to the kernel behind the next batch, the queue has all of them,
      // as inotify's has when libuv reads it.
      // The listeners run from a timer, so a throw is an uncaught exception
      // and their ticks run after them, as in any of Node's callbacks.
      const later = (fn) => timers.setImmediate(fn).unref?.();
      this.#flush = true;
      later(() => {
        const deliver = () => later(() => this.#deliver());
        Promise.resolve(barrier()).then(deliver, deliver);
      });
    }

    // One event a turn: Node's callback for each runs its ticks and promise
    // jobs before the next (MakeCallback), so an iterator reads one at a time.
    #deliver() {
      if (this.#closed || !this.#queue.length) {
        this.#flush = false;
        return;
      }
      const { eventType, filename } = this.#queue.shift();
      if (this.#queue.length) timers.setImmediate(() => this.#deliver()).unref?.();
      else this.#flush = false;
      this.onchange(0, eventType, encode(filename, this.#encoding));
    }

    ref() {
      if (this.#closed || this.#refed) return;
      this.#refed = true;
      if (this.initialized) handles?.add(this.#entry);
    }

    unref() {
      if (!this.#refed) return;
      this.#refed = false;
      handles?.delete(this.#entry);
    }

    close() {
      if (this.#closed) return;
      this.#closed = true;
      this.#queue.length = 0;
      try {
        this.#watch?.close();
      } catch {
        /* the kernel's close is idempotent; nothing to report */
      }
      this.#watch = null;
      this.unref();
    }
  }

  /** UVException for a watch, with the `filename` Node adds. */
  const watchError = (err, filename) => {
    const error = uvException(err, 'watch', filename);
    error.filename = filename;
    return error;
  };

  // --- lib/internal/fs/watchers.js
  function FSWatcher() {
    Reflect.apply(EventEmitter, this, []);
    this._handle = new FSEvent();
    this._handle.owner = this;
    this._handle.onchange = (status, eventType, filename) => {
      if (status < 0) {
        if (this._handle !== null) {
          // Not this.close(): no 'close' event.
          this._handle.close();
          this._handle = null;
        }
        this.emit('error', watchError(status, filename));
      } else {
        this.emit('change', eventType, filename);
      }
    };
  }
  Object.setPrototypeOf(FSWatcher.prototype, EventEmitter.prototype);
  Object.setPrototypeOf(FSWatcher, EventEmitter);

  FSWatcher.prototype[kFSWatchStart] = function start(filename, persistent, recursive, encoding) {
    if (this._handle === null) return;
    if (this._handle.initialized) return;
    filename = validatedPath(filename, 'filename');
    const err = this._handle.start(filename, persistent, recursive, encoding);
    if (err) throw watchError(err, filename);
  };

  // Node keeps a no-op start() for old callers.
  FSWatcher.prototype.start = () => {};

  FSWatcher.prototype.close = function close() {
    if (this._handle === null) return;
    if (!this._handle.initialized) return;
    this._handle.close();
    this._handle = null;
    process.nextTick(() => this.emit('close'));
  };

  FSWatcher.prototype.ref = function ref() {
    if (this._handle) this._handle.ref();
    return this;
  };

  FSWatcher.prototype.unref = function unref() {
    if (this._handle) this._handle.unref();
    return this;
  };

  // --- lib/internal/fs/recursive_watch.js: Linux's `recursive`.
  // Node's class is FSWatcher too.
  const RecursiveWatcher = class FSWatcher extends EventEmitter {
    #options = null;
    #closed = false;
    #files = new Map();
    #watchers = new Map();
    #symbolicFiles = new Set();
    #rootPath = path.resolve();
    #watchingFile = false;

    constructor(options = kEmptyObject) {
      super();
      const { persistent, recursive, signal, encoding } = options;
      if (recursive != null) validateBoolean(recursive, 'options.recursive');
      if (persistent != null) validateBoolean(persistent, 'options.persistent');
      if (signal != null) validateAbortSignal(signal, 'options.signal');
      // Node throws this here, as it would on macOS and Windows.
      if (encoding != null && typeof encoding !== 'string') throw ERR_INVALID_ARG_VALUE('options.encoding', encoding);
      this.#options = { persistent, recursive, signal, encoding };
    }

    close() {
      if (this.#closed) return;
      this.#closed = true;
      for (const file of this.#files.keys()) {
        this.#watchers.get(file)?.close();
        this.#watchers.delete(file);
      }
      this.#files.clear();
      this.#symbolicFiles.clear();
      this.emit('close');
    }

    #unwatchFiles(file) {
      this.#symbolicFiles.delete(file);
      for (const filename of this.#files.keys()) {
        if (filename.startsWith(file)) {
          this.#files.delete(filename);
          this.#watchers.get(filename)?.close();
          this.#watchers.delete(filename);
        }
      }
    }

    #watchFolder(folder) {
      try {
        const files = fs().readdirSync(folder, { withFileTypes: true });
        for (const file of files) {
          if (this.#closed) break;
          const f = path.join(folder, file.name);
          if (!this.#files.has(f)) {
            this.emit('change', 'rename', path.relative(this.#rootPath, f));
            if (file.isSymbolicLink()) this.#symbolicFiles.add(f);
            try {
              this.#watchFile(f);
              if (file.isDirectory() && !file.isSymbolicLink()) this.#watchFolder(f);
            } catch (err) {
              if (err.code !== 'ENOENT') throw err;
            }
          }
        }
      } catch (error) {
        this.emit('error', error);
      }
    }

    #watchFile(file) {
      if (this.#closed) return;
      if (this.#files.has(file)) return;
      this.#files.set(file, fs().statSync(file));
      const watcher = fs().watch(file, { persistent: this.#options.persistent }, () => {
        const existingStat = this.#files.get(file);
        let currentStats;
        try {
          currentStats = fs().statSync(file);
          this.#files.set(file, currentStats);
        } catch {
          // The file was removed.
        }
        if (currentStats === undefined || (currentStats.birthtimeMs === 0 && existingStat.birthtimeMs !== 0)) {
          this.#files.delete(file);
          this.#watchers.delete(file);
          watcher.close();
          this.emit('change', 'rename', path.relative(this.#rootPath, file));
          this.#unwatchFiles(file);
        } else if (file === this.#rootPath && this.#watchingFile) {
          this.emit('change', 'change', path.basename(file));
        } else if (this.#symbolicFiles.has(file)) {
          this.emit('change', 'rename', path.relative(this.#rootPath, file));
        } else if (currentStats.isDirectory()) {
          this.#watchFolder(file);
        } else {
          this.emit('change', 'change', path.relative(this.#rootPath, file));
        }
      });
      this.#watchers.set(file, watcher);
    }

    [kFSWatchStart](filename) {
      filename = path.resolve(target(validatedPath(filename, 'filename')));
      try {
        const file = fs().statSync(filename);
        this.#rootPath = filename;
        this.#closed = false;
        this.#watchingFile = file.isFile();
        this.#watchFile(filename);
        if (file.isDirectory()) this.#watchFolder(filename);
      } catch (error) {
        if (error.code === 'ENOENT') {
          error.filename = filename;
          throw error;
        }
      }
    }

    // Node's: its files are Stats, never a StatWatcher, so these change nothing.
    ref() {
      this.#files.forEach((file) => {
        if (file instanceof StatWatcher) file.ref();
      });
    }

    unref() {
      this.#files.forEach((file) => {
        if (file instanceof StatWatcher) file.unref();
      });
    }

    [Symbol.asyncIterator]() {
      const { signal } = this.#options;
      const promiseExecutor =
        signal == null
          ? (resolve) => {
              this.once('change', (eventType, filename) => {
                resolve({ __proto__: null, value: { eventType, filename } });
              });
            }
          : (resolve, reject) => {
              const aborted = () => {
                this.close();
                reject(new AbortError(undefined, { cause: signal.reason }));
              };
              if (signal.aborted) return aborted();
              const off = onAbort(signal, aborted);
              this.once('change', (eventType, filename) => {
                off();
                resolve({ __proto__: null, value: { eventType, filename } });
              });
            };
      return {
        next: () => (this.#closed ? { __proto__: null, done: true } : new Promise(promiseExecutor)),
        return: () => {
          this.close();
          return { __proto__: null, done: true };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    }
  };

  // --- lib/fs.js watch
  function watch(filename, options, listener) {
    if (typeof options === 'function') listener = options;
    options = { ...getOptions(options) };
    if (options.persistent === undefined) options.persistent = true;
    if (options.recursive === undefined) options.recursive = false;
    let watcher;
    const filepath = validatedPath(filename, 'path');
    if (options.recursive) {
      watcher = new RecursiveWatcher(options);
      watcher[kFSWatchStart](filepath);
    } else {
      watcher = new FSWatcher();
      watcher[kFSWatchStart](filepath, options.persistent, options.recursive, options.encoding);
    }
    if (listener) watcher.addListener('change', listener);
    if (options.signal) {
      if (options.signal.aborted) {
        process.nextTick(() => watcher.close());
      } else {
        const off = onAbort(options.signal, () => watcher.close());
        watcher.once('close', off);
      }
    }
    return watcher;
  }

  // --- lib/internal/fs/watchers.js watch: fs.promises.watch without `recursive`.
  async function* nativeWatch(filename, options = kEmptyObject) {
    const filepath = validatedPath(filename, 'path');
    validateObject(options, 'options');
    const { persistent = true, recursive = false, encoding = 'utf8', maxQueue = 2048, overflow = 'ignore', signal } = options;
    validateBoolean(persistent, 'options.persistent');
    validateBoolean(recursive, 'options.recursive');
    validateInteger(maxQueue, 'options.maxQueue');
    validateOneOf(overflow, 'options.overflow', ['ignore', 'error']);
    validateAbortSignal(signal, 'options.signal');
    // Node 22 passes these the other way round: "The argument 'nope' is invalid encoding. Received 'encoding'".
    if (encoding && !isEncoding(encoding)) throw ERR_INVALID_ARG_VALUE(encoding, 'encoding', 'is invalid encoding');
    if (signal?.aborted) throw new AbortError(undefined, { cause: signal.reason });

    const handle = new FSEvent();
    let { promise, resolve } = Promise.withResolvers();
    const queue = [];
    const oncancel = () => {
      handle.close();
      resolve();
    };
    let off;
    try {
      if (signal) off = onAbort(signal, oncancel);
      handle.onchange = (status, eventType, name) => {
        if (status < 0) {
          handle.close();
          queue.push(watchError(status, name));
          resolve();
          return;
        }
        if (queue.length < maxQueue) {
          queue.push({ __proto__: null, eventType, filename: name });
          resolve();
        } else if (overflow === 'error') {
          queue.length = 0;
          queue.push(ERR_FS_WATCH_QUEUE_OVERFLOW(maxQueue));
          resolve();
        } else {
          process.emitWarning('fs.watch maxQueue exceeded');
        }
      };
      const err = handle.start(filepath, persistent, recursive, encoding);
      if (err) {
        handle.close();
        throw watchError(err, filename);
      }
      while (!signal?.aborted) {
        await promise;
        while (queue.length) {
          const item = queue.shift();
          if (item instanceof Error) throw item;
          yield item;
        }
        ({ promise, resolve } = Promise.withResolvers());
      }
      if (signal?.aborted) throw new AbortError(undefined, { cause: signal?.reason });
    } finally {
      handle.close();
      off?.();
    }
  }

  // --- lib/internal/fs/promises.js _watch: Linux's.
  async function* promisesWatch(filename, options = kEmptyObject) {
    validateObject(options, 'options');
    if (options.recursive != null) {
      validateBoolean(options.recursive, 'options.recursive');
      if (options.recursive) {
        const watcher = new RecursiveWatcher(options);
        watcher[kFSWatchStart](filename);
        yield* watcher;
        return;
      }
    }
    yield* nativeWatch(filename, options);
  }

  return { watch, promisesWatch, FSWatcher };
}

