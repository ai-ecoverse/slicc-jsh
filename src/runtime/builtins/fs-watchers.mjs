/**
 * fs.watchFile / fs.unwatchFile and their StatWatcher, as Node 22.22.0's
 * lib/fs.js and lib/internal/fs/watchers.js, over a poll that does what
 * libuv's uv_fs_poll does (src/fs-poll.c): a stat at the start and then every
 * `interval` ms, a callback when the stat differs from the last one or its
 * error changes. The kernel has no file-change events for programs, so this
 * is how Node does it too, not a stand-in.
 */
import { EventEmitter } from './events.mjs';
import { ERR_INVALID_ARG_TYPE, validateFunction, validateUint32 } from '../node-errors.mjs';

const kOldStatus = Symbol('kOldStatus');
const kUseBigint = Symbol('kUseBigint');
const kRefCount = Symbol('KFSStatWatcherRefCount');
const kMaxRefCount = Symbol('KFSStatWatcherMaxRefCount');
const kStart = Symbol('kFSStatWatcherStart');
const kAddOrCleanRef = Symbol('kFSStatWatcherAddOrCleanRef');

/** The fields uv_fs_poll's statbuf_eq compares (times, size, mode, owner, inode, device). */
const SAME = ['ctimeMs', 'mtimeMs', 'birthtimeMs', 'size', 'mode', 'uid', 'gid', 'ino', 'dev'];

/**
 * @param {object} o
 * @param {(path: string) => object} o.stat the kernel's stat of a path; throws with `code`
 * @param {(st: object | null, bigint: boolean) => object} o.view new Stats for a kernel stat, or all 0 for null (a missing file)
 * @param {(code: string) => number} o.errno the negative libuv errno for a code
 */
// The longest delay a timer takes; a longer interval waits in steps.
const MAX_DELAY = 2147483647;

export function createStatWatchers({ process, path, handles, timers, stat, view, errno }) {
  /** The binding's StatWatcher handle: the poll, counted as a ref'd handle while it runs. */
  class PollHandle {
    #path = '';
    #interval = 1;
    #bigint;
    #timer = null;
    #started = false;
    #closed = false;
    #refed = true;
    #busy = 0;
    // The last stat, as the kernel gave it (null: none yet). Listeners get
    // Stats made from it afresh, so one that changes them changes nothing here.
    #last = null;
    #entry = { kind: 'StatWatcher' };

    constructor(bigint) {
      this.#bigint = bigint;
    }

    start(target, interval) {
      this.#path = target;
      this.#interval = interval || 1;
      this.#started = true;
      if (this.#refed) handles?.add(this.#entry);
      // uv_fs_poll_start stats now; the answer comes on a later turn.
      this.#schedule(0);
      return 0;
    }

    #schedule(delay) {
      const step = Math.min(delay, MAX_DELAY);
      this.#timer = timers.setTimeout(() => (delay > step ? this.#schedule(delay - step) : this.#poll()), step);
      this.#timer.unref?.();
    }

    #poll() {
      if (this.#closed) return;
      const started = Date.now();
      let curr;
      let status = 0;
      try {
        curr = stat(this.#path);
      } catch (err) {
        status = errno(err?.code);
      }
      // Rescheduled before the callback, as poll_cb does: a throwing
      // listener (caught by 'uncaughtException') doesn't stop the polling.
      this.#schedule(this.#interval - ((Date.now() - started) % this.#interval));
      if (status !== 0) {
        if (this.#busy !== status) {
          this.#busy = status;
          this.onchange(status, view(null, this.#bigint), view(this.#last, this.#bigint));
        }
        return;
      }
      const prev = this.#last;
      let report = false;
      if (this.#busy < 0) report = true;
      else if (this.#busy !== 0) {
        const a = view(prev, false);
        const b = view(curr, false);
        report = SAME.some((k) => a[k] !== b[k]);
      }
      this.#last = curr;
      this.#busy = 1;
      if (report) this.onchange(0, view(curr, this.#bigint), view(prev, this.#bigint));
    }

    ref() {
      if (this.#closed || this.#refed) return;
      this.#refed = true;
      if (this.#started) handles?.add(this.#entry);
    }

    unref() {
      if (!this.#refed) return;
      this.#refed = false;
      handles?.delete(this.#entry);
    }

    close() {
      this.#closed = true;
      if (this.#timer) timers.clearTimeout(this.#timer);
      this.#timer = null;
      this.unref();
    }
  }

  function onchange(newStatus, curr, prev) {
    const self = this.owner;
    // Node's: an EPERM at the start, with nothing to compare, says nothing.
    if (self[kOldStatus] === -1 && newStatus === -1 && curr.nlink === prev.nlink) return;
    self[kOldStatus] = newStatus;
    self.emit('change', curr, prev);
  }

  function StatWatcher(bigint) {
    Reflect.apply(EventEmitter, this, []);
    this._handle = null;
    this[kOldStatus] = -1;
    this[kUseBigint] = bigint;
    this[kRefCount] = 1;
    this[kMaxRefCount] = 1;
  }
  Object.setPrototypeOf(StatWatcher.prototype, EventEmitter.prototype);
  Object.setPrototypeOf(StatWatcher, EventEmitter);

  StatWatcher.prototype[kStart] = function start(filename, persistent, interval) {
    if (this._handle !== null) return;
    this._handle = new PollHandle(this[kUseBigint] === true);
    this._handle.owner = this;
    this._handle.onchange = onchange;
    if (!persistent) this.unref();
    this[kOldStatus] = -1;
    validateUint32(interval, 'interval');
    this._handle.start(filename, interval);
  };

  // Node keeps a no-op start() for old callers.
  StatWatcher.prototype.start = () => {};

  StatWatcher.prototype.stop = function stop() {
    if (this._handle === null) return;
    process.nextTick(() => this.emit('stop'));
    this._handle.close();
    this._handle = null;
  };

  StatWatcher.prototype[kAddOrCleanRef] = function addOrCleanRef(operate) {
    if (operate === 'add') {
      this[kRefCount]++;
      this[kMaxRefCount]++;
    } else if (operate === 'clean') {
      this[kMaxRefCount]--;
      this.unref();
    } else if (operate === 'cleanAll') {
      this[kMaxRefCount] = 0;
      this[kRefCount] = 0;
      this._handle?.unref();
    }
  };

  StatWatcher.prototype.ref = function ref() {
    // A ref per listener at most, so an unref() after it still counts.
    if (this[kRefCount] === this[kMaxRefCount]) return this;
    if (this._handle && this[kRefCount]++ === 0) this._handle.ref();
    return this;
  };

  StatWatcher.prototype.unref = function unref() {
    if (this[kRefCount] === 0) return this;
    if (this._handle && --this[kRefCount] === 0) this._handle.unref();
    return this;
  };

  const statWatchers = new Map();

  /** Node's pathModule.resolve(filename): a Buffer path is refused there. */
  const resolved = (filename) => {
    if (typeof filename !== 'string') throw ERR_INVALID_ARG_TYPE('paths[0]', 'string', filename);
    return path.resolve(filename);
  };

  function watchFile(filename, options, listener) {
    filename = resolved(filename);
    let watcher;
    if (options === null || typeof options !== 'object') {
      listener = options;
      options = null;
    }
    // 5007 ms: what libev used, and Node keeps.
    options = { interval: 5007, persistent: true, ...options };
    validateFunction(listener, 'listener');
    watcher = statWatchers.get(filename);
    if (watcher === undefined) {
      watcher = new StatWatcher(options.bigint);
      watcher[kStart](filename, options.persistent, options.interval);
      statWatchers.set(filename, watcher);
    } else {
      watcher[kAddOrCleanRef]('add');
    }
    watcher.addListener('change', listener);
    return watcher;
  }

  function unwatchFile(filename, listener) {
    filename = resolved(filename);
    const watcher = statWatchers.get(filename);
    if (watcher === undefined) return;
    if (typeof listener === 'function') {
      const before = watcher.listenerCount('change');
      watcher.removeListener('change', listener);
      if (watcher.listenerCount('change') < before) watcher[kAddOrCleanRef]('clean');
    } else {
      watcher.removeAllListeners('change');
      watcher[kAddOrCleanRef]('cleanAll');
    }
    if (watcher.listenerCount('change') === 0) {
      watcher.stop();
      statWatchers.delete(filename);
    }
  }

  return { watchFile, unwatchFile, StatWatcher };
}
