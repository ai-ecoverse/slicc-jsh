/**
 * Node-like fs / fs/promises over ctx.sync (sync) and ctx.fs (promises).
 * Async ops are tracked as ref'd handles so the event loop stays alive.
 */
import { trackPromise } from '../async-handles.mjs';
import { createCp } from './fs-cp.mjs';
import { createStatWatchers } from './fs-watchers.mjs';
import { createFsWatch } from './fs-watch.mjs';
import { Dir } from './fs-dir.mjs';
import { UV_ERRORS } from '../node-bindings.mjs';
import {
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_ARG_VALUE,
  ERR_OUT_OF_RANGE,
  validateBoolean,
  validateInt32,
  validateInteger,
  validateObject,
  validateUint32,
  validateAbortSignal,
  validateFunction,
  validateString,
  nodeError,
} from '../node-errors.mjs';
import { kernelAtLeast, kernelVersion } from '../kernel-version.mjs';
import { queueMicrotask } from '../async-context.mjs';
import { kCustomPromisifyArgs } from './util.mjs';

// Node's argument checks (lib/internal/fs/utils.js), before any call.
/** getValidatedFd: an int32 >= 0. */
function validatedFd(fd) {
  validateInt32(fd, 'fd', 0);
  return fd;
}
/** parseFileMode: a uint32, or an octal string. */
function parseFileMode(value, name, def) {
  value ??= def;
  if (typeof value === 'string') {
    if (!/^[0-7]+$/.test(value)) throw ERR_INVALID_ARG_VALUE(name, value, 'must be a 32-bit unsigned integer or an octal string');
    value = Number.parseInt(value, 8);
  }
  validateUint32(value, name);
  return value;
}
/** toUnixTimestamp: a Date, a number of seconds, or a numeric string. */
function toUnixTimestamp(time, name = 'time') {
  // eslint-disable-next-line eqeqeq
  if (typeof time === 'string' && +time == time) return +time;
  if (Number.isFinite(time)) return time < 0 ? Date.now() / 1000 : time;
  if (time instanceof Date || Object.prototype.toString.call(time) === '[object Date]') return time.getTime() / 1000;
  throw ERR_INVALID_ARG_TYPE(name, ['Date', 'Time in seconds'], time);
}
/** getValidatedPath's type check: a string, a Buffer or a URL (a file: URL is a path by then). */
function validatePathType(p) {
  if (typeof p === 'string' || p instanceof Uint8Array || (p && typeof p === 'object' && typeof p.href === 'string')) return;
  throw ERR_INVALID_ARG_TYPE('path', ['string', 'Buffer', 'URL'], p);
}
function validateBufferArray(buffers) {
  if (!Array.isArray(buffers) || !buffers.every((b) => ArrayBuffer.isView(b))) throw ERR_INVALID_ARG_TYPE('buffers', 'ArrayBufferView[]', buffers);
  return buffers;
}
const bytesOf = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
/** Node's argument errors: thrown at the call, never given to a callback. */
const isArgError = (err) => /^ERR_(INVALID_ARG_TYPE|INVALID_ARG_VALUE|OUT_OF_RANGE|MISSING_ARGS)$/.test(err?.code ?? '');
/** A uid / gid: -1 (keep) up to kMaxUserId. */
function validateId(id, name) {
  validateInteger(id, name, -1, 4294967295);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const pathString = (p) => (p instanceof Uint8Array ? decoder.decode(p) : p);

// libuv's error names, numbers (Linux) and messages, as Node's fs errors carry them.
const ERRNO = Object.fromEntries(UV_ERRORS.map(([n, name]) => [name, n]));
const ERRNO_NAMES = Object.fromEntries(UV_ERRORS.map(([n, name]) => [n, name]));
const DESCRIPTIONS = Object.fromEntries(UV_ERRORS.map(([, name, msg]) => [name, msg]));

function nodeFsError(code, syscall, pathArg, err, dest) {
  pathArg = pathString(pathArg);
  dest = pathString(dest);
  const c = typeof code === 'string' ? code : err?.code || 'EIO';
  const desc = DESCRIPTIONS[c] || c;
  let msg;
  if (pathArg === undefined || pathArg === null) {
    msg = `${c}: ${desc}, ${syscall}`;
  } else if (dest !== undefined) {
    msg = `${c}: ${desc}, ${syscall} '${pathArg}' -> '${dest}'`;
  } else {
    msg = `${c}: ${desc}, ${syscall} '${pathArg}'`;
  }
  const e = new Error(msg);
  e.code = c;
  e.errno = ERRNO[c] ?? -1;
  e.syscall = syscall;
  if (pathArg !== undefined && pathArg !== null) e.path = pathArg;
  if (dest !== undefined) e.dest = dest;
  return e;
}

const FS_READ_STREAM = Symbol('fs.ReadStream');
const FS_WRITE_STREAM = Symbol('fs.WriteStream');

/** Node's rm() of a directory without `recursive`. */
function rmIsDirectoryError(pathArg) {
  const e = new Error(`Path is a directory: rm returned EISDIR (is a directory) ${pathArg}`);
  e.name = 'SystemError';
  e.code = 'ERR_FS_EISDIR';
  e.errno = 21;
  e.syscall = 'rm';
  e.path = String(pathArg);
  e.info = { code: 'EISDIR', message: 'is a directory', path: String(pathArg), syscall: 'rm', errno: 21 };
  return e;
}

function toBytes(data) {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return encoder.encode(String(data));
}

/** lib/internal/fs/utils.js StatFs. */
class StatFs {
  constructor(type, bsize, blocks, bfree, bavail, files, ffree, bigint) {
    const v = bigint ? BigInt : (x) => x;
    this.type = v(type);
    this.bsize = v(bsize);
    this.blocks = v(blocks);
    this.bfree = v(bfree);
    this.bavail = v(bavail);
    this.files = v(files);
    this.ffree = v(ffree);
  }
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** Node's fs.Stats: own data fields, type tests on the prototype. */
// Number or bigint mode; anything else (an empty `new fs.Stats()`) matches no type.
const modeType = (mode) => {
  if (typeof mode === 'bigint') return Number(BigInt.asUintN(32, mode) & BigInt(S_IFMT));
  return typeof mode === 'number' ? mode & S_IFMT : -1;
};

class Stats {
  isFile() {
    return modeType(this.mode) === S_IFREG;
  }
  isDirectory() {
    return modeType(this.mode) === S_IFDIR;
  }
  isSymbolicLink() {
    return modeType(this.mode) === S_IFLNK;
  }
  isBlockDevice() {
    return modeType(this.mode) === 0o060000;
  }
  isCharacterDevice() {
    return modeType(this.mode) === 0o020000;
  }
  isFIFO() {
    return modeType(this.mode) === 0o010000;
  }
  isSocket() {
    return modeType(this.mode) === 0o140000;
  }
}

// Node 22: the Date fields are getters on the prototype (not own keys),
// made from the *Ms numbers; assigning one replaces it.
for (const name of ['atime', 'mtime', 'ctime', 'birthtime']) {
  Object.defineProperty(Stats.prototype, name, {
    configurable: true,
    enumerable: false,
    get() {
      return new Date(Number(this[`${name}Ms`]));
    },
    set(value) {
      Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: true });
    },
  });
}

function statView(st, bigint = false) {
  const mtimeMs = st.mtimeMs ?? (st.mtime ? Number(st.mtime) : 0);
  const atimeMs = st.atimeMs ?? mtimeMs;
  const ctimeMs = st.ctimeMs ?? mtimeMs;
  // The kernel's mode carries the file type (character devices, FIFOs, …).
  const kernelType = typeof st.mode === 'number' ? st.mode & S_IFMT : 0;
  const type = kernelType || (st.isDirectory ? S_IFDIR : st.isSymbolicLink ? S_IFLNK : S_IFREG);
  const perm = typeof st.mode === 'number' ? st.mode & ~S_IFMT : st.isDirectory ? 0o755 : 0o644;
  const size = st.size ?? 0;
  if (bigint) {
    const B = (v) => BigInt(Math.trunc(Number(v) || 0));
    const ns = (ms) => BigInt(Math.trunc(ms * 1e6));
    return Object.assign(new Stats(), {
      dev: B(st.dev),
      mode: B(type | perm),
      nlink: B(st.nlink ?? 1),
      uid: B(st.uid),
      gid: B(st.gid),
      rdev: 0n,
      blksize: 4096n,
      ino: B(st.ino),
      size: B(size),
      blocks: B(Math.ceil(size / 512)),
      atimeMs: B(atimeMs),
      mtimeMs: B(mtimeMs),
      ctimeMs: B(ctimeMs),
      birthtimeMs: B(ctimeMs),
      atimeNs: ns(atimeMs),
      mtimeNs: ns(mtimeMs),
      ctimeNs: ns(ctimeMs),
      birthtimeNs: ns(ctimeMs),
    });
  }
  return Object.assign(new Stats(), {
    dev: st.dev ?? 0,
    mode: type | perm,
    nlink: st.nlink ?? 1,
    uid: st.uid ?? 0,
    gid: st.gid ?? 0,
    rdev: 0,
    blksize: 4096,
    ino: st.ino ?? 0,
    size,
    blocks: Math.ceil(size / 512),
    atimeMs,
    mtimeMs,
    ctimeMs,
    birthtimeMs: ctimeMs,
  });
}

/** The Stats uv_fs_poll gives for a file that isn't there: every field 0. */
function zeroStats(bigint) {
  const z = bigint ? 0n : 0;
  const fields = ['dev', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'blksize', 'ino', 'size', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs'];
  if (bigint) fields.push('atimeNs', 'mtimeNs', 'ctimeNs', 'birthtimeNs');
  return Object.assign(new Stats(), Object.fromEntries(fields.map((k) => [k, z])));
}

class Dirent {
  constructor(name, type, parentPath) {
    this.name = name;
    this.parentPath = parentPath;
    this.path = parentPath;
    Object.defineProperty(this, '_type', { value: type, enumerable: false }); // 'file' | 'dir' | 'link' | 'unknown'
  }
  isFile() {
    return this._type === 'file';
  }
  isDirectory() {
    return this._type === 'dir';
  }
  isSymbolicLink() {
    return this._type === 'link';
  }
  isBlockDevice() {
    return false;
  }
  isCharacterDevice() {
    return false;
  }
  isFIFO() {
    return false;
  }
  isSocket() {
    return false;
  }
}

const kStats = Symbol('stats');
export class DirentFromStats extends Dirent {
  constructor(name, stats, parentPath) {
    super(name, null, parentPath);
    this[kStats] = stats;
  }
}
for (const name of Reflect.ownKeys(Dirent.prototype)) {
  if (name !== 'constructor') {
    DirentFromStats.prototype[name] = function () {
      return this[kStats][name]();
    };
  }
}

export function createFs({ ctx, path, process, Buffer, handles, getStream, timers = globalThis }) {
  const abs = (p) => {
    if (typeof p === 'number') return p;
    p = pathString(p);
    return path.isAbsolute(p) ? path.normalize(p) : path.resolve(process.cwd(), p);
  };

  const syncFs = ctx.sync.fs;
  const asyncFs = ctx.fs;
  // slicc-kernel 1.86.0: ctx.fs.chmod / ctx.sync.fs.chmod (#495), and, in the
  // same release, mkdir(p, { recursive: false }) as Node's mkdir without
  // `recursive` (#514: EEXIST / ENOENT, atomic among one kernel's
  // processes). An older kernel's mkdir ignores the option and makes the
  // parents, so chmod's presence stands for both. Older kernels: chmod
  // changes nothing and mkdir checks before it creates, as before.
  const kernelChmod = typeof syncFs.chmod === 'function';
  const exclusiveMkdir = kernelChmod;
  /** Node's chmod(2): the permission bits only, as Linux masks the rest. */
  const chmodPath = (target, mode, syscall, pathArg) => {
    try {
      syncFs.chmod(target, mode & 0o7777);
    } catch (err) {
      throw nodeFsError(err?.code || 'EIO', syscall, pathArg, err);
    }
  };
  let warnedNoChmod = false;
  /** A kernel before 1.86.0 can't change a mode: say so once, rather than not at all. */
  const warnNoChmod = () => {
    if (warnedNoChmod) return;
    warnedNoChmod = true;
    try {
      process?.emitWarning?.('fs.chmod and fs.fchmod change nothing on this slicc-kernel: it needs 1.86.0 or later (ctx.fs.chmod)', {
        code: 'JSH_NO_CHMOD',
      });
    } catch {
      /* no process yet */
    }
  };
  let recursiveRmdirWarned = false;
  /** DEP0147, once per process, as Node's. */
  const emitRecursiveRmdirWarning = () => {
    if (recursiveRmdirWarned) return;
    recursiveRmdirWarned = true;
    process?.emitWarning?.(
      'In future versions of Node.js, fs.rmdir(path, { recursive: true }) will be removed. Use fs.rm(path, { recursive: true }) instead',
      'DeprecationWarning',
      'DEP0147'
    );
  };
  const umaskNow = () => (typeof process?.umask === 'function' ? process.umask() : 0o022);
  const kernelUmask = () => (typeof process?._kernelUmask === 'function' ? process._kernelUmask() : 0o022);
  /**
   * The mode a create asked for, as Node's open / mkdir give it: `mode`
   * (else `def`) less the program's umask. The kernel made the file with
   * `def` less its own umask; null when that is already it (or the kernel
   * can't chmod: before 1.86.0 the mode stays the kernel's).
   */
  // slicc-kernel 1.92.0 (#564): ctx.sync.umask, and a mode on the kernel's
  // creating writeFile / mkdir / open, which it applies less the umask, so
  // a new file never has another mode, even for a moment.
  const kernelModes = typeof ctx.sync?.umask === 'function';
  /** The options that give a kernel create its mode (1.92.0+), else none. */
  const createOpts = (mode, def, extra) =>
    kernelModes ? { ...extra, mode: (mode ?? def) & 0o7777 } : extra;
  const createMode = (mode, def) => {
    if (!kernelChmod || kernelModes) return null;
    // The default mode under the kernel's own umask is what the kernel made.
    if (process?._umask === undefined && (mode === undefined || (mode & 0o7777) === def)) return null;
    const want = (mode ?? def) & ~umaskNow() & 0o7777;
    return want === (def & ~kernelUmask() & 0o7777) ? null : want;
  };
  /** After a create: give the new file or directory the mode Node would. */
  const applyCreateMode = (target, want) => {
    if (want == null) return;
    try {
      syncFs.chmod(target, want);
    } catch {
      /* a mount without modes keeps what it has, as its chmod does */
    }
  };
  const wrapBuffer = (bytes) => (Buffer ? Buffer.from(bytes) : bytes);
  const optEncoding = (options) =>
    typeof options === 'string' ? options : options?.encoding ?? null;
  const optFlag = (options, fallback) =>
    (options && typeof options === 'object' && options.flag) || fallback;
  const ENCODINGS = new Set([
    'utf8', 'utf-8', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le', 'latin1', 'binary',
    'base64', 'base64url', 'hex', 'ascii', 'buffer',
  ]);
  /** Node's assertEncoding: an unknown name is ERR_INVALID_ARG_VALUE. */
  const checkEncoding = (encoding) => {
    if (encoding == null || ENCODINGS.has(String(encoding).toLowerCase())) return;
    const err = new TypeError(`The argument 'encoding' is invalid encoding. Received '${encoding}'`);
    err.code = 'ERR_INVALID_ARG_VALUE';
    throw err;
  };
  /** Bytes read from a file, as Node returns them for `encoding`. */
  const decodeAs = (bytes, encoding) => {
    checkEncoding(encoding);
    if (!encoding) return wrapBuffer(bytes);
    const enc = String(encoding).toLowerCase();
    if (enc === 'buffer') {
      // Node 22 accepts the name, then fails decoding with it.
      const err = new TypeError('Unknown encoding: buffer');
      err.code = 'ERR_UNKNOWN_ENCODING';
      throw err;
    }
    if (enc === 'utf8' || enc === 'utf-8') return decoder.decode(bytes);
    // Node's ascii decoder drops the high bit of each byte.
    if (enc === 'ascii') {
      let out = '';
      for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] & 0x7f);
      return out;
    }
    return Buffer ? Buffer.from(bytes).toString(enc) : decoder.decode(bytes);
  };
  const pathEncoder = (options) => {
    const encoding = optEncoding(options);
    checkEncoding(encoding);
    if (encoding === 'buffer') return (str) => wrapBuffer(encoder.encode(str));
    return encoding && !/^utf-?8$/i.test(encoding) ? (str) => Buffer.from(str).toString(encoding) : (str) => str;
  };
  /** Data to write, as Node encodes a string with `encoding`. */
  const encodeAs = (data, encoding) => {
    checkEncoding(encoding);
    if (typeof data === 'string' && encoding && encoding !== 'utf8' && encoding !== 'utf-8' && Buffer) {
      const b = Buffer.from(data, encoding);
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    }
    return toBytes(data);
  };
  const track = (p) => (handles ? trackPromise(handles, p) : p);

  /** @type {Map<number, { path: string, flags: string, pos: number, readable: boolean, writable: boolean }>} */
  const fdTable = new Map();
  let nextFd = 3;

  function parseFlags(flags) {
    // A number: the O_* bits (Linux's, as fs.constants has them).
    if (typeof flags === 'number') {
      const acc = flags & 3;
      return {
        raw: flags,
        readable: acc === 0 || acc === 2,
        writable: acc === 1 || acc === 2,
        exclusive: !!(flags & 0o200),
        append: !!(flags & 0o2000),
        truncate: !!(flags & 0o1000),
        create: !!(flags & 0o100),
        directory: !!(flags & 0o200000),
        nofollow: !!(flags & 0o400000),
      };
    }
    const f = flags == null ? 'r' : flags;
    // Node's stringToFlags: anything else is ERR_INVALID_ARG_VALUE.
    if (!VALID_FLAGS.has(f)) throw ERR_INVALID_ARG_VALUE('flags', flags);
    const readable = f.includes('r') || f === 'a+' || f === 'w+' || f === 'ax+' || f === 'wx+';
    const writable =
      f.includes('w') || f.includes('a') || f === 'r+' || f === 'rs+' || f === 'as+' || f === 'wx' || f === 'ax';
    const exclusive = f.includes('x');
    const append = f.includes('a');
    const truncate = f.includes('w') && !append;
    const create = writable;
    return { raw: f, readable: readable || f === 'r+', writable, exclusive, append, truncate, create };
  }

  function isPlainOptionsObject(v) {
    return (
      v != null &&
      typeof v === 'object' &&
      !Buffer.isBuffer(v) &&
      !(v instanceof Uint8Array) &&
      !ArrayBuffer.isView(v)
    );
  }

  /** Node readSync(fd, buf, offset, length, position) or readSync(fd, buf, { offset, length, position }). */
  function parseReadSyncArgs(buffer, offset, length, position) {
    if (isPlainOptionsObject(offset)) {
      const opts = offset;
      const bufOffset = opts.offset ?? 0;
      const len = opts.length ?? buffer.length - bufOffset;
      const pos = opts.position !== undefined ? opts.position : null;
      return { bufOffset, length: len, position: pos };
    }
    const bufOffset = offset ?? 0;
    const len = length ?? buffer.length - bufOffset;
    const pos = position !== undefined ? position : null;
    return { bufOffset, length: len, position: pos };
  }

  /**
   * Node writeSync(fd, string[, position[, encoding]]) vs
   * writeSync(fd, buffer[, offset[, length[, position]]]).
   */
  function parseWriteSyncArgs(data, offset, length, position) {
    if (typeof data === 'string') {
      let filePosition = null;
      let encoding;
      if (typeof offset === 'number' || offset === null) {
        filePosition = offset;
        encoding = length;
      } else if (typeof offset === 'string') {
        encoding = offset;
        filePosition = null;
      } else if (offset === undefined) {
        encoding = length;
        filePosition = null;
      }
      void encoding;
      const bytes = toBytes(data);
      return { bytes, filePosition: filePosition ?? null };
    }
    const bufOffset = offset ?? 0;
    const len = length ?? data.length - bufOffset;
    const filePosition = position !== undefined ? position : null;
    let slice;
    if (data.subarray) {
      slice = data.subarray(bufOffset, bufOffset + len);
    } else {
      slice = toBytes(data).subarray(bufOffset, bufOffset + len);
    }
    return { bytes: slice, filePosition };
  }

  /**
   * A path in /dev the kernel opens as a device (1.69+: ctx.sync.open sees
   * /dev). /dev/stdin and /dev/fd/0 stay process.stdin's (see openSync).
   */
  /**
   * The path to open as a device (null when it isn't one): by what it is,
   * not how it's spelled. The kernel shows /dev only by its own paths, so a
   * link to a device is followed here first.
   */
  function devicePathOf(target) {
    if (typeof ctx.sync?.open !== 'function') return null;
    let real = target;
    if (!target.startsWith('/dev/')) {
      try {
        // Follow the links by hand: the kernel's stat of one to /dev is ENOENT.
        for (let hops = 0; syncFs.lstat?.(real)?.isSymbolicLink; hops++) {
          if (hops >= 40) return null;
          real = path.resolve(path.dirname(real), syncFs.readlink(real));
          if (real.startsWith('/dev/')) break;
        }
      } catch {
        return null;
      }
      if (real === target) return null;
    }
    if (real === '/dev/stdin' || real === '/dev/fd/0') return null;
    try {
      const st = syncFs.stat(real);
      return !st.isFile && !st.isDirectory ? real : null;
    } catch {
      return null;
    }
  }
  const isDevicePath = (target) => devicePathOf(target) !== null;

  /**
   * A kernel descriptor on a regular file opened read-only, so readSync reads
   * just the range asked for (fd-pread) instead of the whole file each time,
   * with the stat of the file it opened. null where the kernel has none to
   * give (a directory: EISDIR): the fd then reads by its path. A refusal
   * (EACCES, EMFILE, …) is the open's.
   */
  function openHeld(target, pathArg, options = { read: true }) {
    if (typeof ctx.sync?.open !== 'function') return null;
    let file;
    try {
      file = ctx.sync.open(target, options);
    } catch (err) {
      if (OPEN_REFUSALS.has(err?.code)) throw nodeFsError(err.code, 'open', pathArg, err);
      return null;
    }
    try {
      return { file, opened: syncFs.stat(target) };
    } catch {
      file.close();
      return null;
    }
  }

  /** The bytes from an fd's position to its end; the position moves there. */
  function readRestOf(ent) {
    if (ent.file) {
      const rest = ent.file.read(ent.pos, Math.max(0, ent.file.size() - ent.pos));
      ent.pos += rest.length;
      return rest;
    }
    const bytes = syncFs.readFile(ent.path);
    const rest = bytes.subarray(Math.min(ent.pos, bytes.length));
    ent.pos += rest.length;
    return rest;
  }

  /**
   * An fd's stat: of the file it has open, which its path may no longer name
   * (unlinked, or replaced: Linux's fstat then has nlink 0).
   */
  function statOfFd(ent) {
    if (!ent.file) return syncFs.stat(ent.path);
    const was = ent.opened;
    let st = null;
    try {
      st = syncFs.stat(ent.path);
    } catch {
      st = null;
    }
    if (st && st.ino === was.ino && st.dev === was.dev) return st;
    return { ...was, size: ent.file.size(), nlink: 0 };
  }

  /** Node's readSync position: null, -1 or -1n is the fd's own (null here); else a number. */
  function readPosition(position, length) {
    if (position == null) return null;
    if (typeof position === 'number') {
      validateInteger(position, 'position', -1);
      return position === -1 ? null : position;
    }
    if (typeof position === 'bigint') {
      const max = 2n ** 63n - 1n - BigInt(length);
      if (!(position >= -1n && position <= max)) throw ERR_OUT_OF_RANGE('position', `>= -1 && <= ${max}`, position);
      return position === -1n ? null : Number(position);
    }
    throw ERR_INVALID_ARG_TYPE('position', ['integer', 'bigint'], position);
  }

  /** writeFileSync / appendFileSync of a device: open, write, close, as Node's do. */
  function writeThroughDescriptor(p, bytes, flag) {
    const fd = syncApi.openSync(p, flag);
    try {
      let off = 0;
      while (off < bytes.byteLength) off += syncApi.writeSync(fd, bytes, off, bytes.byteLength - off);
    } finally {
      syncApi.closeSync(fd);
    }
  }

  function writeBytesAtPath(ent, bytes, filePosition) {
    const inPlace = writableFileOf(ent, ent.append ?? String(ent.flags).includes('a'));
    if (inPlace) {
      try {
        const pos = inPlace.append ? inPlace.file.size() : filePosition == null ? ent.pos : filePosition;
        const n = inPlace.file.write(pos, bytes);
        const written = typeof n === 'number' ? n : bytes.length;
        if (filePosition == null) ent.pos = pos + written;
        if (inPlace.held) inPlace.file.sync();
        return written;
      } finally {
        if (!inPlace.held) inPlace.file.close();
      }
    }
    let cur = new Uint8Array(0);
    try {
      cur = syncFs.readFile(ent.path);
    } catch {
      cur = new Uint8Array(0);
    }
    // An append descriptor writes at the end whatever the position (Linux's O_APPEND).
    const append = ent.append ?? String(ent.flags).includes('a');
    const pos = append ? cur.length : filePosition == null ? ent.pos : filePosition;
    const out = new Uint8Array(Math.max(cur.length, pos + bytes.length));
    out.set(cur, 0);
    out.set(bytes, pos);
    syncFs.writeFile(ent.path, out);
    if (filePosition == null) ent.pos = pos + bytes.length;
    return bytes.length;
  }

  function parseReadCallbackArgs(buffer, offset, length, position, callback) {
    if (typeof offset === 'function') {
      return { bufOffset: 0, length: buffer.length, position: null, callback: offset };
    }
    if (isPlainOptionsObject(offset) && typeof length === 'function') {
      const opts = offset;
      const bufOffset = opts.offset ?? 0;
      return {
        bufOffset,
        length: opts.length ?? buffer.length - bufOffset,
        position: opts.position !== undefined ? opts.position : null,
        callback: length,
      };
    }
    if (typeof length === 'function') {
      return {
        bufOffset: offset ?? 0,
        length: buffer.length - (offset ?? 0),
        position: null,
        callback: length,
      };
    }
    if (typeof position === 'function') {
      return {
        bufOffset: offset ?? 0,
        length: length ?? buffer.length - (offset ?? 0),
        position: null,
        callback: position,
      };
    }
    return {
      bufOffset: offset ?? 0,
      length: length ?? buffer.length - (offset ?? 0),
      position: position !== undefined ? position : null,
      callback,
    };
  }

  function parseWriteCallbackArgs(data, a1, a2, a3, a4) {
    if (typeof data === 'string') {
      if (typeof a1 === 'function') return { syncArgs: [], callback: a1 };
      if (typeof a2 === 'function') return { syncArgs: [a1], callback: a2 };
      if (typeof a3 === 'function') return { syncArgs: [a1, a2], callback: a3 };
      return { syncArgs: [a1, a2], callback: a4 };
    }
    if (typeof a1 === 'function') return { syncArgs: [], callback: a1 };
    if (typeof a2 === 'function') return { syncArgs: [a1], callback: a2 };
    if (typeof a3 === 'function') return { syncArgs: [a1, a2], callback: a3 };
    return { syncArgs: [a1, a2, a3], callback: a4 };
  }

  function readStdinSync(encoding) {
    try {
      if (typeof process?._readStdinSync === 'function') {
        return decodeAs(process._readStdinSync(), encoding);
      }
      if (typeof process?.stdin?._readAllSync === 'function') {
        return decodeAs(process.stdin._readAllSync(), encoding);
      }
      if (typeof ctx.sync?.read === 'function') {
        const chunks = [];
        for (;;) {
          const c = ctx.sync.read(0);
          if (!c || c.byteLength === 0) break;
          chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c));
        }
        let total = 0;
        for (const c of chunks) total += c.length;
        const out = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
          out.set(c, at);
          at += c.length;
        }
        return decodeAs(out, encoding);
      }
    } catch {
      /* fall through */
    }
    return decodeAs(new Uint8Array(0), encoding);
  }

  function mkdirSync(p, options = {}) {
    const pathArg = p;
    const target = abs(p);
    const recursive = options === true || options?.recursive === true;
    // Node's mkdir: `mode` (or the options as a mode), default 0o777, less the umask.
    const modeArg = typeof options === 'number' || typeof options === 'string' ? options : isPlainOptionsObject(options) ? options.mode : undefined;
    const askedMode = parseFileMode(modeArg, isPlainOptionsObject(options) ? 'options.mode' : 'mode', 0o777);
    const dirMode = createMode(askedMode, 0o777);
    if (!recursive) {
      if (exclusiveMkdir) {
        // The kernel answers EEXIST / ENOENT / ENOTDIR itself, so of two
        // processes making one name exactly one succeeds. 1.93.0 and 1.94.0
        // say EIO for '/' (#659, fixed in 1.94.1): it always exists.
        if (target === '/' && mkdirRootEio) throw nodeFsError('EEXIST', 'mkdir', pathArg);
        try {
          syncFs.mkdir(target, createOpts(askedMode, 0o777, { recursive: false }));
        } catch (err) {
          throw nodeFsError(err?.code || 'EIO', 'mkdir', pathArg, err);
        }
        applyCreateMode(target, dirMode);
        return;
      }
      if (syncFs.exists(target)) throw nodeFsError('EEXIST', 'mkdir', pathArg);
      try {
        syncFs.mkdir(target);
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'mkdir', pathArg, err);
      }
      return;
    }
    // Node: the first directory created, or undefined when all existed,
    // named the way `p` was given (its prefixes, by dirname, keep any './').
    const given = [];
    for (let cur = String(p); ; ) {
      given.unshift(cur);
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    const parts = String(target).split('/').filter(Boolean);
    let cur = '';
    let first;
    let firstAbs;
    for (const part of parts) {
      cur += `/${part}`;
      if (syncFs.exists(cur)) {
        let st;
        try {
          st = syncFs.stat(cur);
        } catch {
          st = null;
        }
        // The path itself a file: EEXIST; a file on the way: ENOTDIR (Node's).
        if (st && !st.isDirectory) throw nodeFsError(cur === target ? 'EEXIST' : 'ENOTDIR', 'mkdir', pathArg);
        continue;
      }
      try {
        syncFs.mkdir(cur, createOpts(askedMode, 0o777));
        firstAbs ??= cur;
        applyCreateMode(cur, dirMode);
      } catch (err) {
        if (err?.code === 'EEXIST') continue;
        throw nodeFsError(err?.code || 'EIO', 'mkdir', pathArg, err);
      }
    }
    if (firstAbs !== undefined) {
      first = given.find((g) => abs(g) === firstAbs) ?? firstAbs;
    }
    return first;
  }

  const typeAt = (full) => {
    try {
      const st = syncFs.lstat(full);
      return st.isDirectory ? 'dir' : st.isSymbolicLink ? 'link' : st.isFile ? 'file' : 'unknown';
    } catch {
      return 'unknown';
    }
  };

  function mustExist(p, syscall) {
    let ok = false;
    try {
      ok = syncFs.exists(abs(p));
    } catch {
      ok = false;
    }
    if (!ok) throw nodeFsError('ENOENT', syscall, p);
  }

  /** Node's validateRmdirOptions with rm's defaults (lib/internal/fs/utils.js). */
  function validateRmOptions(options) {
    const defaults = { recursive: false, force: false, retryDelay: 100, maxRetries: 0 };
    if (options === undefined) return defaults;
    validateObject(options, 'options');
    const opts = { ...defaults, ...options };
    validateBoolean(opts.recursive, 'options.recursive');
    validateInt32(opts.retryDelay, 'options.retryDelay', 0);
    validateUint32(opts.maxRetries, 'options.maxRetries');
    validateBoolean(opts.force, 'options.force');
    return opts;
  }

  const kernelRefusesDev = kernelAtLeast(ctx, '1.93.0');
  const mkdirRootEio = kernelAtLeast(ctx, '1.93.0') && !kernelAtLeast(ctx, '1.94.1');
  const writesInPlace = typeof ctx.sync?.open === 'function' && kernelAtLeast(ctx, '1.143.4');

  function openInPlace(target, { write, append = false }) {
    try {
      return { file: ctx.sync.open(target, { write, append }), append };
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  function writableFileOf(ent, append = false) {
    if (ent.file && ent.writable) return { file: ent.file, append, held: true };
    return writesInPlace && openInPlace(ent.path, { write: true, append });
  }

  /**
   * A removal the kernel answered ENOENT for, of an entry that is still there
   * (a /dev device: the kernel keeps them, ai-ecoverse/slicc-kernel#637): as
   * Linux refuses it, EACCES for a user, EPERM for root. Else the code as is.
   */
  const removalCode = (code, target) => {
    // From slicc-kernel 1.93.0 (#641) the kernel refuses these itself.
    if (code !== 'ENOENT' || kernelRefusesDev) return code;
    try {
      syncFs.lstat(target);
    } catch {
      return code;
    }
    return euid() === 0 ? 'EPERM' : 'EACCES';
  };
  const euid = () => (typeof process?.geteuid === 'function' ? process.geteuid() : 0);

  /**
   * Linux's may_delete() of an entry of `dirTarget`, as rmdir(2) checks it
   * before it looks at the entry's contents: write and search permission on
   * the directory (EACCES), and its sticky bit (EPERM unless the caller owns
   * the entry or the directory). Root passes. Null when allowed.
   */
  // Before slicc-kernel 1.86.0 (no chmod) the modes it reports are its
  // defaults, which it doesn't enforce: nothing to check there.
  function deleteRefused(dirTarget, entry) {
    const uid = euid();
    if (uid === 0 || !kernelChmod) return null;
    let dir;
    try {
      dir = syncFs.lstat(dirTarget);
    } catch {
      return null;
    }
    if (typeof dir.mode !== 'number') return null;
    const groups = new Set(typeof process?.getgroups === 'function' ? process.getgroups() : []);
    if (typeof process?.getegid === 'function') groups.add(process.getegid());
    const bits = dir.uid === uid ? (dir.mode >> 6) & 7 : groups.has(dir.gid) ? (dir.mode >> 3) & 7 : dir.mode & 7;
    if ((bits & 3) !== 3) return 'EACCES';
    if (dir.mode & 0o1000 && dir.uid !== uid && entry?.uid !== uid) return 'EPERM';
    return null;
  }

  /**
   * rmdir(2) on the kernel, whose rm is recursive: a directory with entries
   * fails, with EACCES / EPERM when its parent refuses the removal (Linux
   * checks that first), else ENOTEMPTY; an empty one goes to the kernel's rm.
   */
  function rmdirOnly(shown, target) {
    let st;
    try {
      st = syncFs.lstat(target);
    } catch (err) {
      throw nodeFsError(err?.code || 'ENOENT', 'rmdir', shown, err);
    }
    if (!st.isDirectory) throw nodeFsError('ENOTDIR', 'rmdir', shown);
    let names;
    try {
      names = syncFs.readdir(target);
    } catch (err) {
      throw nodeFsError(err?.code || 'EIO', 'rmdir', shown, err);
    }
    if (names.length > 0) throw nodeFsError(deleteRefused(path.dirname(target), st) ?? 'ENOTEMPTY', 'rmdir', shown);
    try {
      syncFs.rm(target);
    } catch (err) {
      throw nodeFsError(removalCode(err?.code, target) || 'EIO', 'rmdir', shown, err);
    }
    // The kernel may say it removed what it keeps (/dev).
    if (syncFs.exists(target)) throw nodeFsError(euid() === 0 ? 'EPERM' : 'EACCES', 'rmdir', shown);
  }

  function unlinkOnly(shown, target) {
    try {
      syncFs.unlink(target);
    } catch (err) {
      throw nodeFsError(removalCode(err?.code, target) || 'EIO', 'unlink', shown, err);
    }
  }

  function lstatOrNull(target) {
    try {
      return syncFs.lstat(target);
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      return undefined;
    }
  }

  function readdirOf(shown, target) {
    try {
      return syncFs.readdir(target);
    } catch (err) {
      throw nodeFsError(err?.code || 'EIO', 'scandir', shown, err);
    }
  }

  const childOf = (shown, name) => `${shown}${String(shown).endsWith('/') ? '' : '/'}${name}`;
  // Node's (lib/internal/fs/rimraf.js).
  const notEmptyErrorCodes = new Set(['ENOTEMPTY', 'EEXIST', 'EPERM']);
  const retryErrorCodes = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);
  const sleepMs = (ms) => {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
      /* no Atomics.wait here: retry at once */
    }
  };

  /**
   * Node 22's rimrafSync, step for step over the kernel's calls: a
   * directory is rmdir()ed first, and only on ENOTEMPTY / EEXIST / EPERM are
   * its entries (in readdir order) removed and the rmdir tried again; any
   * other error ends the walk where it is. So a tree whose subdirectory
   * can't be emptied fails on that subdirectory's own rmdir (EACCES) and
   * keeps what came after it, as Node's does. `shown` is the path as the
   * error names it (the caller's path joined with '/' and each name).
   */
  function rimrafSync(shown, target, opts) {
    const st = lstatOrNull(target);
    if (st === null) return;
    try {
      if (st?.isDirectory) rmdirSyncTree(shown, target, opts, null);
      else unlinkSyncRetry(shown, target, opts);
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      if (err?.code === 'EPERM') return rmdirSyncTree(shown, target, opts, err);
      if (err?.code !== 'EISDIR') throw err;
      rmdirSyncTree(shown, target, opts, err);
    }
  }

  function unlinkSyncRetry(shown, target, opts) {
    const tries = opts.maxRetries + 1;
    for (let i = 1; i <= tries; i++) {
      try {
        return unlinkOnly(shown, target);
      } catch (err) {
        if (retryErrorCodes.has(err?.code) && i < tries && opts.retryDelay > 0) sleepMs(i * opts.retryDelay);
        else if (err?.code === 'ENOENT') return;
        else if (i === tries) throw err;
      }
    }
  }

  function rmdirSyncTree(shown, target, opts, originalErr) {
    try {
      rmdirOnly(shown, target);
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      if (err?.code === 'ENOTDIR') throw originalErr || err;
      if (notEmptyErrorCodes.has(err?.code)) {
        for (const name of readdirOf(shown, target)) rimrafSync(childOf(shown, name), path.join(target, name), opts);
        const tries = opts.maxRetries + 1;
        for (let i = 1; i <= tries; i++) {
          try {
            return rmdirOnly(shown, target);
          } catch (e) {
            if (retryErrorCodes.has(e?.code) && i < tries && opts.retryDelay > 0) sleepMs(i * opts.retryDelay);
            else if (e?.code === 'ENOENT') return;
            else if (i === tries) throw e;
          }
        }
      }
      throw originalErr || err;
    }
  }

  /**
   * Node 22's callback rimraf (fs.rm, fs.promises.rm): the same steps, but
   * a directory's entries are removed side by side, so an error in one
   * subtree doesn't stop its siblings, and the first error to come back is
   * the one reported. The steps run here in the order they are issued, one
   * call each (Node's thread pool may answer two of them in either order;
   * the entries left are the same).
   */
  function rimrafConcurrent(shown, target, opts) {
    const queue = [];
    const step = (fn) => queue.push(fn);
    let result;
    const rimraf = (sh, t, cb) => {
      let retries = 0;
      const CB = (err) => {
        if (err) {
          if (retryErrorCodes.has(err.code) && retries < opts.maxRetries) {
            retries++;
            return step(() => one(sh, t, CB));
          }
          if (err.code === 'ENOENT') err = null;
        }
        cb(err);
      };
      one(sh, t, CB);
    };
    const one = (sh, t, cb) =>
      step(() => {
        const st = lstatOrNull(t);
        if (st === null) return cb(null);
        if (st?.isDirectory) return rmdir(sh, t, null, cb);
        step(() => {
          let err = null;
          try {
            unlinkOnly(sh, t);
          } catch (e) {
            err = e;
          }
          if (err) {
            if (err.code === 'ENOENT') return cb(null);
            if (err.code === 'EISDIR' || err.code === 'EPERM') return rmdir(sh, t, err, cb);
          }
          cb(err);
        });
      });
    const rmdir = (sh, t, originalErr, cb) =>
      step(() => {
        let err = null;
        try {
          rmdirOnly(sh, t);
        } catch (e) {
          err = e;
        }
        if (err) {
          if (notEmptyErrorCodes.has(err.code)) return children(sh, t, cb);
          if (err.code === 'ENOTDIR') return cb(originalErr);
        }
        cb(err);
      });
    const rmdirAgain = (sh, t, cb) =>
      step(() => {
        try {
          rmdirOnly(sh, t);
          cb(null);
        } catch (e) {
          cb(e);
        }
      });
    const children = (sh, t, cb) =>
      step(() => {
        let files;
        try {
          files = readdirOf(sh, t);
        } catch (e) {
          return cb(e);
        }
        let left = files.length;
        if (left === 0) return rmdirAgain(sh, t, cb);
        let done = false;
        for (const name of files) {
          rimraf(childOf(sh, name), path.join(t, name), (err) => {
            if (done) return;
            if (err) {
              done = true;
              return cb(err);
            }
            if (--left === 0) rmdirAgain(sh, t, cb);
          });
        }
      });
    rimraf(shown, target, (err) => {
      result = { err };
    });
    while (queue.length > 0) queue.shift()();
    if (result?.err) throw result.err;
  }

  // How many symlinks a path may pass through before the kernel refuses it
  // (Linux's MAXSYMLINKS): Node's recursive readdir follows linked
  // directories until the OS answers ELOOP.
  const MAX_LINK_DEPTH = 40;

  // `followLinks`: Node descends into linked directories in readdirSync
  // (names and dirents) and promises.readdir (names), not in
  // promises.readdir with dirents nor in opendir.
  function readdirSync(p, options, { followLinks = true } = {}) {
    const pathArg = p;
    const target = abs(p);
    const encoding = optEncoding(options);
    checkEncoding(encoding);
    const asName = (name) => (encoding === 'buffer' ? wrapBuffer(encoder.encode(name)) : name);
    const dirent = (name, type, parent) => new Dirent(asName(name), type, parent);
    let names;
    try {
      names = syncFs.readdir(target);
    } catch (err) {
      throw nodeFsError(err?.code || 'ENOENT', 'scandir', pathArg, err);
    }
    if (!options?.recursive) {
      if (options?.withFileTypes) {
        return names.map((name) => dirent(name, typeAt(path.join(target, name)), pathArg instanceof Uint8Array ? pathArg : String(pathArg)));
      }
      return names.map(asName);
    }
    // Node's recursive listing: breadth first, paths relative to `p`, and
    // into directories behind symlinks too (lib/fs.js handleDirents).
    const out = [];
    const queue = [{ dir: target, rel: '', parent: String(pathArg), names, links: 0 }];
    while (queue.length) {
      const { dir, rel, parent, names: entries, links } = queue.shift();
      for (const name of entries) {
        const full = path.join(dir, name);
        const type = typeAt(full);
        out.push(options.withFileTypes ? dirent(name, type, parent) : asName(rel ? `${rel}/${name}` : name));
        let descend = type === 'dir';
        if (followLinks && type === 'link' && links < MAX_LINK_DEPTH) {
          try {
            descend = !!syncFs.stat(full).isDirectory;
          } catch {
            descend = false;
          }
        }
        if (!descend) continue;
        let children;
        try {
          children = syncFs.readdir(full);
        } catch {
          continue;
        }
        queue.push({
          dir: full,
          rel: rel ? `${rel}/${name}` : name,
          parent: path.join(parent, name),
          names: children,
          links: links + (type === 'link' ? 1 : 0),
        });
      }
    }
    return out;
  }

  /** fs.rm / fs.promises.rm: rmSync's checks, then Node's callback rimraf. */
  function rmConcurrent(p, options) {
    const pathArg = p;
    const target = abs(p);
    const opts = validateRmOptions(options);
    if (!opts.force || !opts.recursive) {
      let st;
      try {
        st = syncFs.lstat(target);
      } catch (err) {
        const code = err?.code || 'ENOENT';
        if (!opts.force || (code !== 'ENOENT' && code !== 'ENOTDIR')) throw nodeFsError(code, 'lstat', pathArg, err);
      }
      if (st?.isDirectory && !opts.recursive) throw rmIsDirectoryError(pathArg);
    }
    rimrafConcurrent(pathArg, target, opts);
  }

  const syncApi = {
    readFileSync(p, options) {
      const encoding = optEncoding(options);
      checkEncoding(encoding);
      if (p === 0 || p === '0') return readStdinSync(encoding);
      if (typeof p === 'number') {
        const ent = fdTable.get(p);
        if (!ent || !ent.readable) throw nodeFsError('EBADF', 'read', undefined);
        try {
          return decodeAs(readRestOf(ent), encoding);
        } catch (err) {
          throw nodeFsError(err?.code || 'EIO', 'read', undefined, err);
        }
      }
      const pathArg = p;
      // Node: /dev/stdin (and /dev/fd/0) read the process stdin stream.
      if (pathArg === '/dev/stdin' || pathArg === '/dev/fd/0') {
        return readStdinSync(encoding);
      }
      const target = abs(p);
      try {
        const st = syncFs.stat(target);
        if (st.isDirectory) {
          // Node's readFile on a dir: syscall read, no path on the error object.
          const e = new Error('EISDIR: illegal operation on a directory, read');
          e.code = 'EISDIR';
          e.errno = ERRNO.EISDIR;
          e.syscall = 'read';
          throw e;
        }
        return decodeAs(syncFs.readFile(target), encoding);
      } catch (err) {
        if ((err?.code && err.syscall) || String(err?.code).startsWith('ERR_')) throw err;
        throw nodeFsError(err?.code || 'ENOENT', 'open', pathArg, err);
      }
    },
    writeFileSync(p, data, options) {
      // Node's validateStringAfterArrayBufferView, before anything else.
      if (typeof data !== 'string' && !ArrayBuffer.isView(data)) {
        throw ERR_INVALID_ARG_TYPE('data', ['string', 'Buffer', 'TypedArray', 'DataView'], data);
      }
      const bytes = encodeAs(data, optEncoding(options));
      const flag = optFlag(options, 'w');
      // A descriptor: write at its position (stdout/stderr included).
      if (typeof p === 'number') {
        syncApi.writeSync(p, bytes);
        return;
      }
      // An append flag appends, its `x` (O_EXCL) included.
      if (flag.includes('a')) {
        syncApi.appendFileSync(p, bytes, { flag });
        return;
      }
      const pathArg = p;
      const target = abs(p);
      if (isDevicePath(target)) return writeThroughDescriptor(p, bytes, flag);
      // Node's open: options.mode (default 0o666) for a file it creates.
      const askedMode = isPlainOptionsObject(options) ? parseFileMode(options.mode, 'mode', 0o666) : undefined;
      const want = createMode(askedMode, 0o666);
      const existed = want != null || flag.includes('x') ? syncFs.exists(target) : true;
      if (flag.includes('x') && existed) throw nodeFsError('EEXIST', 'open', pathArg);
      if (flag.startsWith('r')) {
        if (writesInPlace) {
          let file;
          try {
            file = ctx.sync.open(target, { write: true });
          } catch (err) {
            throw nodeFsError(err?.code || 'ENOENT', 'open', pathArg, err);
          }
          try {
            file.write(0, bytes);
          } catch (err) {
            throw nodeFsError(err?.code || 'EIO', 'write', pathArg, err);
          } finally {
            file.close();
          }
          return;
        }
        // r+: the file must exist; write from the start, keep what's beyond.
        let cur;
        try {
          cur = syncFs.readFile(target);
        } catch (err) {
          throw nodeFsError(err?.code || 'ENOENT', 'open', pathArg, err);
        }
        const out = new Uint8Array(Math.max(cur.length, bytes.length));
        out.set(cur, 0);
        out.set(bytes, 0);
        try {
          syncFs.writeFile(target, out);
        } catch (err) {
          throw nodeFsError(err?.code || 'EIO', 'write', pathArg, err);
        }
        return;
      }
      try {
        syncFs.writeFile(target, bytes, createOpts(askedMode, 0o666));
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'open', pathArg, err);
      }
      if (!existed) applyCreateMode(target, want);
    },
    appendFileSync(p, data, options) {
      if (typeof data !== 'string' && !ArrayBuffer.isView(data)) {
        throw ERR_INVALID_ARG_TYPE('data', ['string', 'Buffer', 'TypedArray', 'DataView'], data);
      }
      const next = encodeAs(data, optEncoding(options));
      // A flag other than append (Node allows any) writes as writeFileSync does.
      const flag = optFlag(options, 'a');
      if (!flag.includes('a')) {
        syncApi.writeFileSync(p, next, { flag, ...(isPlainOptionsObject(options) && options.mode !== undefined ? { mode: options.mode } : {}) });
        return;
      }
      if (typeof p === 'number') {
        const ent = fdTable.get(p);
        let end = null;
        if (ent) {
          try {
            end = ent.file ? ent.file.size() : (syncFs.stat(ent.path).size ?? 0);
          } catch {
            end = 0;
          }
        }
        syncApi.writeSync(p, next, 0, next.length, end);
        return;
      }
      const pathArg = p;
      const target = abs(p);
      if (isDevicePath(target)) return writeThroughDescriptor(p, next, flag);
      // 'ax' / 'ax+': O_EXCL, as the open behind Node's appendFile has it.
      if (flag.includes('x') && syncFs.exists(target)) throw nodeFsError('EEXIST', 'open', pathArg);
      const askedMode = isPlainOptionsObject(options) ? parseFileMode(options.mode, 'mode', 0o666) : undefined;
      const want = createMode(askedMode, 0o666);
      let existed = true;
      try {
        let prev = new Uint8Array(0);
        existed = syncFs.exists(target);
        if (existed && writesInPlace) {
          const file = ctx.sync.open(target, { write: true, append: true });
          try {
            file.write(file.size(), next);
          } finally {
            file.close();
          }
          return;
        }
        if (existed) prev = syncFs.readFile(target);
        const merged = new Uint8Array(prev.length + next.length);
        merged.set(prev);
        merged.set(next, prev.length);
        syncFs.writeFile(target, merged, existed ? undefined : createOpts(askedMode, 0o666));
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'open', pathArg, err);
      }
      if (!existed) applyCreateMode(target, want);
    },
    existsSync(p) {
      try {
        return syncFs.exists(abs(p));
      } catch {
        return false;
      }
    },
    accessSync(p, mode = 0) {
      const pathArg = p;
      const target = abs(p);
      try {
        if (!syncFs.exists(target)) throw nodeFsError('ENOENT', 'access', pathArg);
        // Mode bits: F_OK=0, R_OK=4, W_OK=2, X_OK=1. Kernel fs has no mode
        // checks beyond existence; treat any non-zero mode like F_OK.
        void mode;
      } catch (err) {
        if (err?.code) throw err;
        throw nodeFsError(err?.code || 'ENOENT', 'access', pathArg, err);
      }
    },
    statSync(p, options) {
      const pathArg = p;
      try {
        return statView(syncFs.stat(abs(p)), options?.bigint === true);
      } catch (err) {
        const code = err?.code || 'ENOENT';
        if (options?.throwIfNoEntry === false && (code === 'ENOENT' || code === 'ENOTDIR')) return undefined;
        throw nodeFsError(code, 'stat', pathArg, err);
      }
    },
    /**
     * Node's StatFs. The kernel's storage estimate (ctx.sync.fs.statfs on
     * slicc-kernel 1.72+: quota and usage) in 4 KiB blocks, as tmpfs (the
     * program's files live in the browser's storage, which has no inodes:
     * files/ffree follow the blocks); 1 GiB where the kernel has no estimate.
     */
    statfsSync(p, options) {
      const target = abs(p);
      try {
        syncFs.stat(target);
      } catch (err) {
        throw nodeFsError(err?.code || 'ENOENT', 'statfs', p, err);
      }
      let usage = null;
      try {
        usage = syncFs.statfs?.(target) ?? null;
      } catch {
        usage = null;
      }
      const bsize = 4096;
      const quota = usage ? usage.quota : 1024 ** 3;
      const used = usage ? Math.min(usage.usage, quota) : 0;
      const blocks = Math.floor(quota / bsize);
      const bfree = Math.floor((quota - used) / bsize);
      return new StatFs(0x01021994, bsize, blocks, bfree, bfree, blocks, bfree, options?.bigint === true);
    },
    lstatSync(p, options) {
      const pathArg = p;
      try {
        return statView(syncFs.lstat(abs(p)), options?.bigint === true);
      } catch (err) {
        const code = err?.code || 'ENOENT';
        if (options?.throwIfNoEntry === false && code === 'ENOENT') return undefined;
        throw nodeFsError(code, 'lstat', pathArg, err);
      }
    },
    /** Node's JS realpath: every symlink along the path resolved. */
    realpathSync(p, options) {
      const encode = pathEncoder(options);
      return encode(getCp().realpathSync(abs(p)));
    },
    readdirSync,
    mkdirSync,
    // The kernel's rm is recursive: only ever hand it an empty directory.
    rmdirSync(p, options = {}) {
      const pathArg = p;
      const target = abs(p);
      // Node 22 (lib/fs.js emitRecursiveRmdirWarning), for rmdir, rmdirSync
      // and promises.rmdir alike, which all come here.
      if (options?.recursive) emitRecursiveRmdirWarning();
      let st;
      try {
        st = syncFs.lstat(target);
      } catch (err) {
        // Node's recursive rmdir checks with lstat (validateRmOptionsSync).
        throw nodeFsError(err?.code || 'ENOENT', options?.recursive ? 'lstat' : 'rmdir', pathArg, err);
      }
      // Even with `recursive`, rmdir removes directories only (Node).
      if (!st.isDirectory) throw nodeFsError('ENOTDIR', 'rmdir', pathArg);
      if (options?.recursive) {
        syncApi.rmSync(p, { ...options, recursive: true, force: false });
        return;
      }
      let entries;
      try {
        entries = syncFs.readdir(target);
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'rmdir', pathArg, err);
      }
      if (entries.length > 0) throw nodeFsError('ENOTEMPTY', 'rmdir', pathArg);
      try {
        syncFs.rm(target);
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'rmdir', pathArg, err);
      }
    },
    rmSync(p, options) {
      const pathArg = p;
      const target = abs(p);
      const opts = validateRmOptions(options);
      // Node's validateRmOptionsSync: lstat first, unless force and recursive
      // (then the removal itself reports what it meets). force forgives a
      // missing path only.
      if (!opts.force || !opts.recursive) {
        let st;
        try {
          st = syncFs.lstat(target);
        } catch (err) {
          const code = err?.code || 'ENOENT';
          if (!opts.force || (code !== 'ENOENT' && code !== 'ENOTDIR')) throw nodeFsError(code, 'lstat', pathArg, err);
        }
        if (st?.isDirectory && !opts.recursive) throw rmIsDirectoryError(pathArg);
      }
      rimrafSync(pathArg, target, opts);
    },
    unlinkSync(p) {
      const pathArg = p;
      try {
        syncFs.unlink(abs(p));
      } catch (err) {
        throw nodeFsError(removalCode(err?.code, abs(p)) || 'ENOENT', 'unlink', pathArg, err);
      }
    },
    renameSync(from, to) {
      try {
        syncFs.rename(abs(from), abs(to));
      } catch (err) {
        throw nodeFsError(err?.code || 'ENOENT', 'rename', from, err, to);
      }
    },
    openSync(p, flags = 'r', mode) {
      const pathArg = p;
      // Node's order: the path, the flags, the mode, then the file system.
      validatePathType(p);
      parseFileMode(mode, 'mode', 0o666);
      if (pathArg === '/dev/stdin' || pathArg === '/dev/fd/0') {
        return 0;
      }
      const fl = parseFlags(flags);
      const target = abs(p);
      // A device (/dev/null, /dev/zero, /dev/urandom, /dev/stdout, /dev/fd/N, …):
      // a kernel descriptor on it (slicc-kernel 1.69+), read and written as a
      // stream, never whole.
      const device = devicePathOf(target);
      if (device) {
        let file;
        try {
          file = ctx.sync.open(device, {
            read: fl.readable || fl.raw === 'r',
            write: fl.writable,
            append: fl.append,
            create: fl.create,
            exclusive: fl.exclusive,
            truncate: fl.truncate,
          });
        } catch (err) {
          throw nodeFsError(err?.code || 'EIO', 'open', pathArg, err);
        }
        const fd = nextFd++;
        fdTable.set(fd, { path: target, flags: fl.raw, pos: 0, readable: fl.readable || fl.raw === 'r', writable: fl.writable, device: file });
        return fd;
      }
      // O_NOFOLLOW: a link is ELOOP; O_DIRECTORY: anything but a directory is ENOTDIR.
      if (fl.nofollow) {
        let lst;
        try {
          lst = syncFs.lstat(target);
        } catch {
          lst = undefined;
        }
        if (lst?.isSymbolicLink) throw nodeFsError('ELOOP', 'open', pathArg);
      }
      const exists = syncFs.exists(target);
      if (fl.directory) {
        if (!exists) throw nodeFsError('ENOENT', 'open', pathArg);
        if (!syncFs.stat(target).isDirectory) throw nodeFsError('ENOTDIR', 'open', pathArg);
      }
      if (fl.exclusive && exists) throw nodeFsError('EEXIST', 'open', pathArg);
      if (!exists) {
        if (!fl.create) throw nodeFsError('ENOENT', 'open', pathArg);
        const askedMode = parseFileMode(mode, 'mode', 0o666);
        try {
          syncFs.writeFile(target, new Uint8Array(0), createOpts(askedMode, 0o666));
        } catch (err) {
          throw nodeFsError(err?.code || 'EIO', 'open', pathArg, err);
        }
        // Node's open: `mode` (default 0o666) less the umask, for the file it made.
        applyCreateMode(target, createMode(askedMode, 0o666));
      } else if (fl.truncate) {
        try {
          syncFs.writeFile(target, new Uint8Array(0));
        } catch (err) {
          throw nodeFsError(err?.code || 'EIO', 'open', pathArg, err);
        }
      }
      let pos = 0;
      if (fl.append) {
        try {
          pos = syncFs.stat(target).size ?? 0;
        } catch {
          pos = 0;
        }
      }
      const ranged = openHeld(target, pathArg, fl.writable ? { read: !!fl.readable, write: true, append: !!fl.append } : undefined);
      const fd = nextFd++;
      fdTable.set(fd, {
        path: target,
        flags: fl.raw,
        append: fl.append,
        pos,
        readable: fl.readable || fl.raw === 'r',
        writable: fl.writable,
        file: ranged?.file ?? null,
        opened: ranged?.opened ?? null,
      });
      return fd;
    },
    readSync(fd, buffer, offset, length, position) {
      validatedFd(fd);
      const { bufOffset, length: len, position: rawPosition } = parseReadSyncArgs(
        buffer,
        offset,
        length,
        position
      );
      const filePosition = readPosition(rawPosition, len);
      if (fd === 0) {
        const data = readStdinSync(null);
        const src = data instanceof Uint8Array ? data : encoder.encode(String(data));
        const n = Math.min(len, src.length);
        buffer.set(src.subarray(0, n), bufOffset);
        return n;
      }
      const ent = fdTable.get(fd);
      if (!ent || !ent.readable) throw nodeFsError('EBADF', 'read', undefined);
      if (ent.device) {
        try {
          const chunk = ent.device.read(0, len);
          const n = Math.min(len, chunk?.length ?? 0);
          if (n) buffer.set(chunk.subarray(0, n), bufOffset);
          return n;
        } catch (err) {
          throw nodeFsError(err?.code || 'EIO', 'read', undefined, err);
        }
      }
      if (ent.file) {
        try {
          // Node: with no position, read at the fd's own and move it.
          const pos = filePosition ?? ent.pos;
          const chunk = len > 0 ? ent.file.read(pos, len) : new Uint8Array(0);
          const n = Math.min(len, chunk.length);
          if (n) buffer.set(chunk.subarray(0, n), bufOffset);
          if (filePosition == null) ent.pos = pos + n;
          return n;
        } catch (err) {
          throw nodeFsError(err?.code || 'EIO', 'read', ent.path, err);
        }
      }
      try {
        const bytes = syncFs.readFile(ent.path);
        const pos = filePosition == null ? ent.pos : filePosition;
        const n = Math.min(len, Math.max(0, bytes.length - pos));
        buffer.set(bytes.subarray(pos, pos + n), bufOffset);
        if (filePosition == null) ent.pos = pos + n;
        return n;
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'read', ent.path, err);
      }
    },
    writeSync(fd, data, offset, length, position) {
      validatedFd(fd);
      if (fd === 1 || fd === 2) {
        const { bytes } = parseWriteSyncArgs(data, offset, length, position);
        ctx.sync.write(fd, bytes);
        return bytes.byteLength;
      }
      const ent = fdTable.get(fd);
      // A descriptor opened read-only cannot be written (Node: EBADF).
      if (!ent || !ent.writable) throw nodeFsError('EBADF', 'write', undefined);
      const { bytes, filePosition } = parseWriteSyncArgs(data, offset, length, position);
      if (ent.device) {
        try {
          const n = ent.device.write(0, bytes);
          return typeof n === 'number' ? n : bytes.byteLength;
        } catch (err) {
          throw nodeFsError(err?.code || 'EIO', 'write', undefined, err);
        }
      }
      try {
        return writeBytesAtPath(ent, bytes, filePosition);
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'write', undefined, err);
      }
    },
    fstatSync(fd, options) {
      validatedFd(fd);
      const ent = fdTable.get(fd);
      if (!ent) throw nodeFsError('EBADF', 'fstat', undefined);
      try {
        return statView(statOfFd(ent), options?.bigint === true);
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'fstat', ent.path, err);
      }
    },
    ftruncateSync(fd, len = 0) {
      validatedFd(fd);
      validateInteger(len, 'len');
      len = Math.max(0, len);
      const ent = fdTable.get(fd);
      if (!ent) throw nodeFsError('EBADF', 'ftruncate', undefined);
      try {
        const inPlace = writableFileOf(ent);
        if (inPlace) {
          try {
            inPlace.file.truncate(len);
            if (inPlace.held) inPlace.file.sync();
          } finally {
            if (!inPlace.held) inPlace.file.close();
          }
          return;
        }
        let cur = syncFs.readFile(ent.path);
        if (len < cur.length) cur = cur.subarray(0, len);
        else if (len > cur.length) {
          const out = new Uint8Array(len);
          out.set(cur, 0);
          cur = out;
        }
        syncFs.writeFile(ent.path, cur);
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'ftruncate', undefined, err);
      }
    },
    closeSync(fd) {
      validatedFd(fd);
      if (fd === 0 || fd === 1 || fd === 2) return;
      if (!fdTable.has(fd)) throw nodeFsError('EBADF', 'close', undefined);
      const ent = fdTable.get(fd);
      fdTable.delete(fd);
      ent.closed = true;
      // A file a child is still being given (child_process hold()) keeps
      // its kernel descriptor until that is done, as a dup'd fd would.
      if (ent.holds > 0) return;
      closeKernelFile(ent);
    },
    symlinkSync(target, p) {
      try {
        syncFs.symlink(target, abs(p));
      } catch (err) {
        // Node names both: symlink 'target' -> 'path'.
        throw nodeFsError(err?.code || 'EIO', 'symlink', target, err, p);
      }
    },
    readlinkSync(p, options) {
      const encode = pathEncoder(options);
      try {
        return encode(syncFs.readlink(abs(p)));
      } catch (err) {
        throw nodeFsError(err?.code || 'ENOENT', 'readlink', p, err);
      }
    },
    copyFileSync(src, dest, mode = 0) {
      if (mode == null) mode = 0;
      if (typeof mode !== 'number' || !Number.isInteger(mode)) {
        const err = new TypeError('mode must be int32 or null/undefined');
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      if (mode < 0 || mode > 7) {
        const err = new RangeError('mode is out of range: >= 0 && <= 7');
        err.code = 'ERR_OUT_OF_RANGE';
        throw err;
      }
      const from = abs(src);
      const to = abs(dest);
      let st;
      try {
        st = syncFs.stat(from);
      } catch (err) {
        throw nodeFsError(err?.code || 'ENOENT', 'copyfile', src, err, dest);
      }
      if (st.isDirectory) throw nodeFsError('EISDIR', 'copyfile', src, undefined, dest);
      // COPYFILE_EXCL = 1
      if (mode & 1 && syncFs.exists(to)) throw nodeFsError('EEXIST', 'copyfile', src, undefined, dest);
      try {
        syncFs.writeFile(to, syncFs.readFile(from));
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'copyfile', src, err, dest);
      }
      // libuv's copyfile gives the copy the source's mode, a new copy or not.
      if (kernelChmod && typeof st.mode === 'number') {
        const perm = st.mode & 0o7777;
        try {
          if ((syncFs.stat(to).mode & 0o7777) !== perm) syncFs.chmod(to, perm);
        } catch {
          /* a mount without modes */
        }
      }
    },
    cpSync(src, dest, options) {
      getCp().cpSync(src, dest, options);
    },
    mkdtempSync(prefix, options, { namedError = false } = {}) {
      const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      const bytes = new Uint8Array(6);
      for (let attempt = 0; attempt < 100; attempt++) {
        crypto.getRandomValues(bytes);
        const name = `${prefix}${[...bytes].map((b) => chars[b % chars.length]).join('')}`;
        const target = abs(name);
        if (syncFs.exists(target)) continue;
        // The kernel's mkdir makes parents; Node's mkdtemp does not.
        const parent = path.dirname(target);
        let parentOk = false;
        try {
          parentOk = !!syncFs.stat(parent).isDirectory;
        } catch {
          parentOk = false;
        }
        // Sync errors show the template, the promise form the name it tried.
        if (!parentOk) throw nodeFsError('ENOENT', 'mkdtemp', namedError ? name : `${prefix}XXXXXX`);
        try {
          // Exclusive where the kernel has it: a name taken meanwhile is tried again.
          if (exclusiveMkdir) syncFs.mkdir(target, createOpts(0o700, 0o700, { recursive: false }));
          else syncFs.mkdir(target);
        } catch (err) {
          if (err?.code === 'EEXIST') continue;
          throw nodeFsError(err?.code || 'ENOENT', 'mkdtemp', `${prefix}XXXXXX`, err);
        }
        // mkdtemp(3): 0700, less the umask.
        applyCreateMode(target, createMode(0o700, 0o777));
        return optEncoding(options) === 'buffer' ? wrapBuffer(encoder.encode(name)) : name;
      }
      throw nodeFsError('EEXIST', 'mkdtemp', `${prefix}XXXXXX`);
    },
    truncateSync(p, len = 0) {
      if (typeof p === 'number') {
        syncApi.ftruncateSync(p, len);
        return;
      }
      const target = abs(p);
      let cur;
      try {
        cur = syncFs.readFile(target);
      } catch (err) {
        throw nodeFsError(err?.code || 'ENOENT', 'open', p, err);
      }
      const out = new Uint8Array(Math.max(0, len));
      out.set(cur.subarray(0, Math.min(cur.length, out.length)), 0);
      syncFs.writeFile(target, out);
    },
    // chmod goes to the kernel where it has one (1.86.0+; it follows a
    // symlink, and only the owner or root may: EPERM). Otherwise, and for
    // chown and utimes, which the kernel's JS fs doesn't have: these check
    // that the path exists, as Node's do, and change nothing (chmod says so
    // once, as a warning).
    chmodSync(p, mode) {
      validatePathType(p);
      mode = parseFileMode(mode, 'mode');
      if (kernelChmod) return chmodPath(abs(p), mode, 'chmod', p);
      mustExist(p, 'chmod');
      warnNoChmod();
    },
    fchmodSync(fd, mode) {
      validatedFd(fd);
      mode = parseFileMode(mode, 'mode');
      const ent = fdTable.get(fd);
      // By the descriptor's path: jsh's descriptors are paths (Node's fchmod
      // errors name no path).
      if (!ent) throw nodeFsError('EBADF', 'fchmod', undefined);
      if (kernelChmod) chmodPath(ent.path, mode, 'fchmod');
      else warnNoChmod();
    },
    chownSync(p, uid, gid) {
      validatePathType(p);
      validateId(uid, 'uid');
      validateId(gid, 'gid');
      mustExist(p, 'chown');
    },
    lchownSync(p, uid, gid) {
      validatePathType(p);
      validateId(uid, 'uid');
      validateId(gid, 'gid');
      mustExist(p, 'lchown');
    },
    fchownSync(fd, uid, gid) {
      validatedFd(fd);
      validateId(uid, 'uid');
      validateId(gid, 'gid');
      syncApi.fstatSync(fd);
    },
    utimesSync(p, atime, mtime) {
      validatePathType(p);
      // Node's utimes / lutimes name both `time`.
      toUnixTimestamp(atime);
      toUnixTimestamp(mtime);
      mustExist(p, 'utime');
    },
    lutimesSync(p, atime, mtime) {
      validatePathType(p);
      toUnixTimestamp(atime);
      toUnixTimestamp(mtime);
      mustExist(p, 'lutime');
    },
    futimesSync(fd, atime, mtime) {
      validatedFd(fd);
      toUnixTimestamp(atime, 'atime');
      toUnixTimestamp(mtime, 'mtime');
      syncApi.fstatSync(fd);
    },
    fsyncSync(fd) {
      validatedFd(fd);
      if (fd !== 0 && fd !== 1 && fd !== 2 && !fdTable.has(fd)) throw nodeFsError('EBADF', 'fsync', undefined);
    },
    fdatasyncSync(fd) {
      validatedFd(fd);
      if (fd !== 0 && fd !== 1 && fd !== 2 && !fdTable.has(fd)) throw nodeFsError('EBADF', 'fdatasync', undefined);
    },
    opendirSync(p, options) {
      return openDir(p, options, undefined);
    },
    readvSync(fd, buffers, position) {
      validatedFd(fd);
      validateBufferArray(buffers);
      return readBuffers(fd, buffers, typeof position === 'number' ? position : null);
    },
    writevSync(fd, buffers, position) {
      validatedFd(fd);
      validateBufferArray(buffers);
      if (buffers.length === 0) return 0;
      return writeBuffers(fd, buffers, typeof position === 'number' ? position : null);
    },
    linkSync(existingPath, newPath) {
      // The kernel decides: tmpfs links (one inode, nlink 2), the root file
      // system and fsa refuse (EPERM), across mounts it's EXDEV.
      try {
        syncFs.link(abs(existingPath), abs(newPath));
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'link', existingPath, err, newPath);
      }
    },
  };

  function readBuffers(fd, buffers, position) {
    if (buffers.length === 0) throw nodeFsError('EINVAL', 'read', undefined);
    let total = 0;
    for (const view of buffers) {
      const n = syncApi.readSync(fd, bytesOf(view), 0, view.byteLength, position === null ? null : position + total);
      total += n;
      if (n < view.byteLength) break;
    }
    return total;
  }
  function writeBuffers(fd, buffers, position) {
    const bytes = new Uint8Array(buffers.reduce((n, b) => n + b.byteLength, 0));
    let at = 0;
    for (const view of buffers) {
      bytes.set(bytesOf(view), at);
      at += view.byteLength;
    }
    return syncApi.writeSync(fd, bytes, 0, bytes.length, position);
  }
  function vectored(name, run, empty) {
    const fn = {
      [name](fd, buffers, position, callback) {
        validatedFd(fd);
        validateBufferArray(buffers);
        const cb = callback || position;
        validateFunction(cb, 'cb');
        const pos = typeof position === 'number' ? position : null;
        let result = 0;
        let error = null;
        if (!(empty && buffers.length === 0)) {
          try {
            result = run(fd, buffers, pos);
          } catch (err) {
            error = err;
          }
        }
        queueMicrotask(() => cb(error, result, buffers));
      },
    }[name];
    Object.defineProperty(fn, kCustomPromisifyArgs, { value: [name === 'readv' ? 'bytesRead' : 'bytesWritten', name === 'readv' ? 'buffers' : 'buffer'], enumerable: false });
    return fn;
  }
  function openDir(p, options, errPath) {
    validatePathType(p);
    const opts = typeof options === 'string' ? { encoding: options } : (options ?? {});
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true, recursive: opts.recursive === true, encoding: opts.encoding }, { followLinks: false });
    } catch (err) {
      if (isArgError(err)) throw err;
      throw nodeFsError(err?.code || 'ENOENT', 'opendir', errPath, err);
    }
    return new Dir({ entries }, p, opts);
  }
  function opendir(p, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    validateFunction(cb, 'callback');
    let dir;
    let error = null;
    try {
      dir = openDir(p, typeof options === 'function' ? undefined : options, p);
    } catch (err) {
      if (isArgError(err)) throw err;
      error = err;
    }
    queueMicrotask(() => (error ? cb(error) : cb(null, dir)));
  }

  let cpImpl;
  function getCp() {
    cpImpl ??= createCp({
      path,
      abs,
      fsError: nodeFsError,
      copyFileSync: (src, dest, mode) => syncApi.copyFileSync(src, dest, mode),
      mkdirpSync: (p) => mkdirSync(p, { recursive: true }),
      ops: {
        lstat: (p) => syncFs.lstat(p),
        stat: (p) => syncFs.stat(p),
        readlink: (p) => syncFs.readlink(p),
        symlink: (target, p) => syncFs.symlink(target, p),
        readdir: (p) => syncFs.readdir(p),
        mkdir: (p) => syncFs.mkdir(p),
        unlink: (p) => syncFs.unlink(p),
      },
    });
    return cpImpl;
  }
  // realpathSync.native and the promise form are realpath(3): their errors
  // name `realpath` and the path as given.
  function realpathNative(p, options) {
    try {
      return syncApi.realpathSync(p, options);
    } catch (err) {
      throw nodeFsError(err?.code || 'ENOENT', 'realpath', p, err);
    }
  }
  syncApi.realpathSync.native = realpathNative;

  /** Node's ERR_INVALID_ARG_TYPE for a missing/invalid fs callback ("cb"). */
  function requireCallback(cb) {
    if (typeof cb === 'function') return cb;
    let received;
    if (cb === undefined) received = 'undefined';
    else if (cb === null) received = 'null';
    else if (typeof cb === 'string') received = `type string ('${cb}')`;
    else if (typeof cb === 'object') {
      const name = cb.constructor?.name;
      received = name && name !== 'Object' ? `an instance of ${name}` : 'an instance of Object';
    } else received = `type ${typeof cb}`;
    const err = new TypeError(`The "cb" argument must be of type function. Received ${received}`);
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }

  /**
   * Wrap a sync fs method as a callback API. Missing/invalid callbacks throw
   * ERR_INVALID_ARG_TYPE synchronously (Node), not "cb is not a function" later.
   * `minArgsBeforeCb` is how many leading args are required before options/cb
   * (1 for readFile/stat; 2 for writeFile/appendFile/rename). Matches Node's
   * maybeCallback(callback || options): at that arity with no function →
   * undefined; one more non-function → that value is the invalid "cb".
   */
  function callbackify(fn, { minArgsBeforeCb = 1 } = {}) {
    return (...args) => {
      let cb;
      let syncArgs;
      if (args.length > 0 && typeof args[args.length - 1] === 'function') {
        cb = args[args.length - 1];
        syncArgs = args.slice(0, -1);
      } else if (args.length <= minArgsBeforeCb) {
        cb = undefined;
        syncArgs = args;
      } else {
        cb = args[args.length - 1];
        syncArgs = args.slice(0, -1);
      }
      requireCallback(cb);
      try {
        const result = fn(...syncArgs);
        queueMicrotask(() => cb(null, result));
      } catch (err) {
        if (isArgError(err)) throw err;
        queueMicrotask(() => cb(err));
      }
    };
  }

  const fileHandles = new WeakSet();
  const promises = {
    readFile(p, options) {
      if (fileHandles.has(p)) return p.readFile(options);
      return track(
        (async () => {
          const encoding = optEncoding(options);
          checkEncoding(encoding);
          try {
            return decodeAs(await asyncFs.readFile(abs(p)), encoding);
          } catch (err) {
            // Argument errors (a bad encoding) stay as they are, as in Node.
            if (String(err?.code).startsWith('ERR_')) throw err;
            throw nodeFsError(err?.code || 'ENOENT', 'open', p, err);
          }
        })()
      );
    },
    // The write happens when the call is made, as Node's open does in call
    // order: a later `flag: 'wx'` sees the file an earlier writeFile made.
    writeFile(p, data, options) {
      if (fileHandles.has(p)) return p.writeFile(data, options);
      let result;
      try {
        syncApi.writeFileSync(p, data, options);
        result = Promise.resolve();
      } catch (err) {
        result = Promise.reject(err);
      }
      return track(result);
    },
    appendFile(p, data, options) {
      if (fileHandles.has(p)) return p.appendFile(data, options);
      let result;
      try {
        syncApi.appendFileSync(p, data, options);
        result = Promise.resolve();
      } catch (err) {
        result = Promise.reject(err);
      }
      return track(result);
    },
    stat(p, options) {
      return track(
        (async () => {
          try {
            return statView(await asyncFs.stat(abs(p)), options?.bigint === true);
          } catch (err) {
            throw nodeFsError(err?.code || 'ENOENT', 'stat', p, err);
          }
        })()
      );
    },
    statfs(p, options) {
      return track(Promise.resolve().then(() => syncApi.statfsSync(p, options)));
    },
    lstat(p, options) {
      return track(
        (async () => {
          try {
            return statView(await asyncFs.lstat(abs(p)), options?.bigint === true);
          } catch (err) {
            throw nodeFsError(err?.code || 'ENOENT', 'lstat', p, err);
          }
        })()
      );
    },
    readdir(p, options) {
      return track((async () => readdirSync(p, options, { followLinks: !options?.withFileTypes }))());
    },
    mkdir(p, options = {}) {
      return track((async () => mkdirSync(p, options))());
    },
    rm(p, options = {}) {
      return track((async () => rmConcurrent(p, options))());
    },
    rmdir(p, options = {}) {
      return track((async () => syncApi.rmdirSync(p, options))());
    },
    copyFile(src, dest, mode) {
      return track((async () => syncApi.copyFileSync(src, dest, mode))());
    },
    cp(src, dest, options) {
      return track(getCp().cp(src, dest, options));
    },
    link(existingPath, newPath) {
      return track((async () => syncApi.linkSync(existingPath, newPath))());
    },
    mkdtemp(prefix, options) {
      return track((async () => syncApi.mkdtempSync(prefix, options, { namedError: true }))());
    },
    truncate(p, len) {
      return track((async () => syncApi.truncateSync(p, len))());
    },
    realpath(p, options) {
      return track((async () => realpathNative(p, options))());
    },
    chmod(p, mode) {
      return track(
        (async () => {
          if (typeof asyncFs.chmod !== 'function') return syncApi.chmodSync(p, mode);
          validatePathType(p);
          mode = parseFileMode(mode, 'mode');
          try {
            await asyncFs.chmod(abs(p), mode & 0o7777);
          } catch (err) {
            throw nodeFsError(err?.code || 'EIO', 'chmod', p, err);
          }
        })()
      );
    },
    // Linux has no lchmod: Node's promise form says so, and fs has none.
    lchmod() {
      return track(
        Promise.reject(Object.assign(new Error('The lchmod() method is not implemented'), { code: 'ERR_METHOD_NOT_IMPLEMENTED' }))
      );
    },
    chown(p, ...args) {
      return track((async () => syncApi.chownSync(p, ...args))());
    },
    lchown(p, ...args) {
      return track((async () => syncApi.lchownSync(p, ...args))());
    },
    utimes(p, ...args) {
      return track((async () => syncApi.utimesSync(p, ...args))());
    },
    lutimes(p, ...args) {
      return track((async () => syncApi.lutimesSync(p, ...args))());
    },
    opendir(p, options) {
      return track((async () => openDir(p, options, p))());
    },
    unlink(p) {
      return track(
        (async () => {
          try {
            await asyncFs.unlink(abs(p));
          } catch (err) {
            throw nodeFsError(removalCode(err?.code, abs(p)) || 'ENOENT', 'unlink', p, err);
          }
        })()
      );
    },
    rename(from, to) {
      return track(
        (async () => {
          try {
            await asyncFs.rename(abs(from), abs(to));
          } catch (err) {
            throw nodeFsError(err?.code || 'ENOENT', 'rename', from, err, to);
          }
        })()
      );
    },
    symlink(target, p) {
      return track(
        (async () => {
          await asyncFs.symlink(target, abs(p));
        })()
      );
    },
    readlink(p, options) {
      return track(
        (async () => {
          const encode = pathEncoder(options);
          try {
            return encode(await asyncFs.readlink(abs(p)));
          } catch (err) {
            throw nodeFsError(err?.code || 'ENOENT', 'readlink', p, err);
          }
        })()
      );
    },
    access(p) {
      return track(
        (async () => {
          if (!(await asyncFs.exists(abs(p)))) throw nodeFsError('ENOENT', 'access', p);
        })()
      );
    },
    async open(p, flags = 'r', mode) {
      const fd = syncApi.openSync(p, flags, mode);
      return createFileHandle(fd);
    },
  };

  function createFileHandle(fd) {
    let closed = false;
    const ensureOpen = (syscall) => {
      if (closed || !fdTable.has(fd)) {
        // Node's fsCall on a closed FileHandle.
        const err = new Error('file closed');
        err.code = 'EBADF';
        err.syscall = syscall;
        throw err;
      }
    };

    const handle = {
      fd,
      async read(buffer, offset, length, position) {
        ensureOpen('read');
        if (isPlainOptionsObject(offset)) {
          const opts = offset;
          const bytesRead = syncApi.readSync(fd, buffer, opts);
          return { bytesRead, buffer };
        }
        const bytesRead = syncApi.readSync(fd, buffer, offset, length, position);
        return { bytesRead, buffer };
      },
      async readv(buffers, position) {
        ensureOpen('readv');
        validateBufferArray(buffers);
        const bytesRead = readBuffers(fd, buffers, typeof position === 'number' ? position : null);
        return { __proto__: null, bytesRead, buffers };
      },
      async writev(buffers, position) {
        ensureOpen('writev');
        validateBufferArray(buffers);
        const bytesWritten = buffers.length === 0 ? 0 : writeBuffers(fd, buffers, typeof position === 'number' ? position : null);
        return { __proto__: null, bytesWritten, buffers };
      },
      async write(data, offset, length, position) {
        ensureOpen('write');
        const bytesWritten = syncApi.writeSync(fd, data, offset, length, position);
        return { bytesWritten, buffer: data };
      },
      async writeFile(data, options) {
        ensureOpen('writeFile');
        syncApi.writeFileSync(fd, data, options);
      },
      async appendFile(data, options) {
        ensureOpen('appendFile');
        syncApi.writeFileSync(fd, data, options);
      },
      async stat(options) {
        ensureOpen('stat');
        return syncApi.fstatSync(fd, options);
      },
      async truncate(len = 0) {
        ensureOpen('truncate');
        syncApi.ftruncateSync(fd, len);
      },
      async readFile(options) {
        ensureOpen('readFile');
        return syncApi.readFileSync(fd, options);
      },
      async sync() {
        ensureOpen('fsync');
      },
      async datasync() {
        ensureOpen('fdatasync');
      },
      async chmod(mode) {
        ensureOpen('fchmod');
        syncApi.fchmodSync(fd, mode);
      },
      async chown(uid, gid) {
        ensureOpen('fchown');
        validateId(uid, 'uid');
        validateId(gid, 'gid');
      },
      async utimes(atime, mtime) {
        ensureOpen('futimes');
        toUnixTimestamp(atime, 'atime');
        toUnixTimestamp(mtime, 'mtime');
      },
      async close() {
        ensureOpen('close');
        closed = true;
        syncApi.closeSync(fd);
      },
      async [Symbol.asyncDispose ?? Symbol.for('nodejs.asyncDispose')]() {
        if (!closed) await handle.close();
      },
    };
    fileHandles.add(handle);
    return handle;
  }

  function openStreamFd(p, flags, options, onOpen, onError) {
    try {
      const fileFd = options?.fd != null ? options.fd : syncApi.openSync(p, flags, options?.mode);
      onOpen(fileFd);
    } catch (err) {
      onError(err);
    }
  }

  function createReadStream(p, options = {}) {
    // Node: a string is the encoding, checked as Node's assertEncoding does.
    if (typeof options === 'string') options = { encoding: options };
    checkEncoding(options?.encoding);
    const stream = getStream?.();
    if (!stream) throw new Error('fs.createReadStream: stream not available');
    const { Readable } = stream;
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const highWaterMark = options?.highWaterMark ?? 64 * 1024;
    let fd = options?.fd;
    let autoClose = options?.autoClose !== false;
    let pos = options?.start ?? 0;
    const end = options?.end;
    let opened = fd != null;
    let openEmitted = opened;

    // autoClose: the descriptor closes as the stream is destroyed (after end/finish,
    // or by destroy()), and fd is null again (Node).
    const closeFd = () => {
      if (autoClose && fd != null && fd !== 0) {
        const f = fd;
        fd = null;
        syncApi.closeSync(f);
      }
    };
    const r = new Readable({
      highWaterMark,
      destroy(err, cb) {
        try {
          closeFd();
        } catch {
          /* already closed */
        }
        cb(err);
      },
      read(size) {
        try {
          if (!opened) {
            fd = syncApi.openSync(p, options?.flags ?? 'r');
            opened = true;
            if (!openEmitted) {
              openEmitted = true;
              r.emit('open', fd);
              r.emit('ready');
            }
          }
          const toRead = end != null ? Math.min(size, end - pos + 1) : size;
          if (toRead <= 0) {
            this.push(null);
            return;
          }
          const buf = Buffer.alloc(toRead);
          const n = syncApi.readSync(fd, buf, 0, toRead, pos);
          r.bytesRead += n;
          if (n === 0) {
            this.push(null);
            return;
          }
          pos += n;
          const chunk = buf.subarray(0, n);
          this.push(chunk);
        } catch (err) {
          this.destroy(err);
        }
      },
    });
    if (options?.fd == null) r.path = p;
    // Node's ReadStream: an encoding is the stream's (strings, a character never split).
    if (encoding) r.setEncoding(encoding);
    Object.defineProperty(r, 'fd', {
      get: () => fd ?? null,
      set: (v) => {
        fd = v;
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(r, 'pending', { get: () => fd == null, enumerable: false, configurable: true });
    r.bytesRead = 0;
    Object.defineProperty(r, FS_READ_STREAM, { value: true });

    if (!openEmitted) {
      queueMicrotask(() => {
        if (openEmitted || r.destroyed) return;
        openStreamFd(p, options?.flags ?? 'r', options, (fileFd) => {
          if (r.destroyed) return;
          fd = fileFd;
          opened = true;
          openEmitted = true;
          r.emit('open', fd);
          r.emit('ready');
        }, (err) => {
          r.destroy(err);
        });
      });
    } else {
      queueMicrotask(() => {
        r.emit('open', fd);
        r.emit('ready');
      });
    }
    return r;
  }

  function createWriteStream(p, options = {}) {
    if (typeof options === 'string') options = { encoding: options };
    checkEncoding(options?.encoding);
    const stream = getStream?.();
    if (!stream) throw new Error('fs.createWriteStream: stream not available');
    const { Writable } = stream;
    const highWaterMark = options?.highWaterMark ?? 64 * 1024;
    let fd = options?.fd;
    let autoClose = options?.autoClose !== false;
    let opened = fd != null;
    let openEmitted = opened;
    const flags = options?.flags ?? 'w';

    // autoClose: the descriptor closes as the stream is destroyed (after end/finish,
    // or by destroy()), and fd is null again (Node).
    const closeFd = () => {
      if (autoClose && fd != null && fd !== 0 && fd !== 1 && fd !== 2) {
        const f = fd;
        fd = null;
        syncApi.closeSync(f);
      }
    };
    const w = new Writable({
      highWaterMark,
      destroy(err, cb) {
        try {
          closeFd();
        } catch {
          /* already closed */
        }
        cb(err);
      },
      write(chunk, enc, cb) {
        try {
          if (!opened) {
            fd = syncApi.openSync(p, flags, options?.mode);
            opened = true;
            if (!openEmitted) {
              openEmitted = true;
              w.emit('open', fd);
              w.emit('ready');
            }
          }
          const n = syncApi.writeSync(fd, chunk);
          w.bytesWritten += n;
          cb();
        } catch (err) {
          cb(err);
        }
      },
      final(cb) {
        cb();
      },
    });
    // Node's WriteStream: strings are written in its encoding.
    if (options?.encoding) w.setDefaultEncoding(options.encoding);
    if (options?.fd == null) w.path = p;
    w.bytesWritten = 0;
    // Node's: the descriptor once open (null before), and pending until then.
    Object.defineProperty(w, 'fd', {
      get: () => fd ?? null,
      set: (v) => {
        fd = v;
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(w, 'pending', { get: () => fd == null, enumerable: false, configurable: true });
    Object.defineProperty(w, FS_WRITE_STREAM, { value: true });

    if (!openEmitted) {
      queueMicrotask(() => {
        if (openEmitted || w.destroyed) return;
        openStreamFd(p, flags, options, (fileFd) => {
          if (w.destroyed) return;
          fd = fileFd;
          opened = true;
          openEmitted = true;
          w.emit('open', fd);
          w.emit('ready');
        }, (err) => {
          w.destroy(err);
        });
      });
    } else {
      queueMicrotask(() => {
        w.emit('open', fd);
        w.emit('ready');
      });
    }
    return w;
  }

  // fs.ReadStream / fs.WriteStream: callable like Node's, and `instanceof`
  // holds for the streams createReadStream / createWriteStream make.
  const streamPath = (p, options) => (options?.fd != null ? p : getValidatedPath(p, 'path', { keepBuffer: true }));
  function ReadStream(p, options) {
    return createReadStream(streamPath(p, options), options);
  }
  Object.defineProperty(ReadStream, Symbol.hasInstance, { value: (x) => !!x?.[FS_READ_STREAM] });
  function WriteStream(p, options) {
    return createWriteStream(streamPath(p, options), options);
  }
  Object.defineProperty(WriteStream, Symbol.hasInstance, { value: (x) => !!x?.[FS_WRITE_STREAM] });

  /**
   * For child_process: the open file behind a jsh fd, kept as a child keeps
   * a dup'd descriptor. It shares the fd's position while the fd is open and
   * outlives a closeSync() of it. null when jsh has no such fd.
   */
  /** Close the kernel descriptor behind a jsh fd, if it has one. */
  function closeKernelFile(ent) {
    try {
      (ent.device ?? ent.file)?.close();
    } catch {
      /* closed */
    }
  }

  function openFileOf(fd) {
    const ent = fdTable.get(fd);
    if (!ent) return null;
    /**
     * Keep the fd's kernel descriptor open past a closeSync() of the jsh fd
     * until the returned release() (child_process: until the child has it).
     */
    const hold = () => {
      ent.holds = (ent.holds ?? 0) + 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        ent.holds -= 1;
        if (ent.holds === 0 && ent.closed) closeKernelFile(ent);
      };
    };
    if (ent.device) {
      // A device: its kernel descriptor (kernelFd) can be a child's stdio as
      // it is; fed and drained here, it streams, up to the kernel's 64 MiB.
      return {
        kernelFd: ent.device.fd,
        hold,
        write(bytes) {
          let off = 0;
          while (bytes?.length && off < bytes.length) off += ent.device.write(0, bytes.subarray(off)) || bytes.length - off;
        },
        readRest() {
          const chunks = [];
          let total = 0;
          for (;;) {
            const chunk = ent.device.read(0, 64 * 1024);
            if (!chunk?.length) break;
            chunks.push(chunk);
            total += chunk.length;
            if (total > 64 * 1024 * 1024) throw nodeFsError('EFBIG', 'read', undefined);
          }
          const out = new Uint8Array(total);
          let at = 0;
          for (const c of chunks) {
            out.set(c, at);
            at += c.length;
          }
          return out;
        },
      };
    }
    return {
      ...(ent.file ? { hold } : {}),
      write(bytes) {
        if (bytes?.length) writeBytesAtPath(ent, bytes, null);
      },
      /** The rest of the file from the position on (the position moves to its end). */
      readRest() {
        return readRestOf(ent);
      },
    };
  }

  const fsModule = {
    ...syncApi,
    promises,
    Dirent,
    ReadStream,
    WriteStream,
    createReadStream,
    createWriteStream,
    readFile: callbackify(syncApi.readFileSync),
    writeFile: callbackify(syncApi.writeFileSync, { minArgsBeforeCb: 2 }),
    appendFile: callbackify(syncApi.appendFileSync, { minArgsBeforeCb: 2 }),
    open: callbackify(syncApi.openSync),
    close: callbackify(syncApi.closeSync),
    read(fd, buffer, offset, length, position, callback) {
      validatedFd(fd);
      const parsed = parseReadCallbackArgs(buffer, offset, length, position, callback);
      const cb = requireCallback(parsed.callback);
      queueMicrotask(() => {
        try {
          const bytesRead = syncApi.readSync(
            fd,
            buffer,
            parsed.bufOffset,
            parsed.length,
            parsed.position
          );
          cb(null, bytesRead, buffer);
        } catch (err) {
          cb(err);
        }
      });
    },
    write(fd, data, offset, length, position, callback) {
      validatedFd(fd);
      const parsed = parseWriteCallbackArgs(data, offset, length, position, callback);
      const cb = requireCallback(parsed.callback);
      queueMicrotask(() => {
        try {
          const written = syncApi.writeSync(fd, data, ...parsed.syncArgs);
          cb(null, written, data);
        } catch (err) {
          cb(err);
        }
      });
    },
    fstat: callbackify(syncApi.fstatSync),
    exists(p, cb) {
      requireCallback(cb);
      queueMicrotask(() => cb(syncApi.existsSync(p)));
    },
    access: callbackify(syncApi.accessSync),
    stat: callbackify(syncApi.statSync),
    statfs: callbackify(syncApi.statfsSync),
    lstat: callbackify(syncApi.lstatSync),
    realpath: Object.assign(callbackify(syncApi.realpathSync), {
      native: callbackify(realpathNative),
    }),
    readdir: callbackify(syncApi.readdirSync),
    mkdir: callbackify(syncApi.mkdirSync, { minArgsBeforeCb: 2 }),
    rmdir: callbackify(syncApi.rmdirSync),
    unlink: callbackify(syncApi.unlinkSync),
    rename: callbackify(syncApi.renameSync, { minArgsBeforeCb: 2 }),
    // Node 22's rm does not check its callback up front: without one it does
    // the work, then calls the missing callback and throws from there.
    rm(p, options, callback) {
      const cb = typeof options === 'function' ? options : callback;
      const opts = typeof options === 'function' ? undefined : options;
      if (typeof cb === 'function') return opts === undefined ? callbackify(rmConcurrent)(p, cb) : callbackify(rmConcurrent)(p, opts, cb);
      let err = null;
      try {
        rmConcurrent(p, opts);
      } catch (e) {
        // Node validates the options before it starts: those throw here.
        if (isArgError(e)) throw e;
        err = e;
      }
      void err;
      // A macrotask later, as the thread pool would answer.
      timers.setTimeout(() => {
        const e = new TypeError('callback is not a function');
        e._fsPretty = `node:fs:1225\n      return callback(err);\n             ^\n\n${e.stack}\n`;
        throw e;
      }, 0);
      return undefined;
    },
    copyFile: callbackify(syncApi.copyFileSync, { minArgsBeforeCb: 2 }),
    cp(src, dest, options, callback) {
      const cb = typeof options === 'function' ? options : callback;
      const opts = typeof options === 'function' ? undefined : options;
      requireCallback(cb);
      track(getCp().cp(src, dest, opts)).then(
        () => cb(null),
        (err) => cb(err)
      );
    },
    link: callbackify(syncApi.linkSync, { minArgsBeforeCb: 2 }),
    mkdtemp: callbackify(syncApi.mkdtempSync),
    truncate: callbackify(syncApi.truncateSync),
    ftruncate: callbackify(syncApi.ftruncateSync),
    chmod: callbackify(syncApi.chmodSync, { minArgsBeforeCb: 2 }),
    fchmod: callbackify(syncApi.fchmodSync, { minArgsBeforeCb: 2 }),
    chown: callbackify(syncApi.chownSync, { minArgsBeforeCb: 3 }),
    lchown: callbackify(syncApi.lchownSync, { minArgsBeforeCb: 3 }),
    fchown: callbackify(syncApi.fchownSync, { minArgsBeforeCb: 3 }),
    utimes: callbackify(syncApi.utimesSync, { minArgsBeforeCb: 3 }),
    lutimes: callbackify(syncApi.lutimesSync, { minArgsBeforeCb: 3 }),
    futimes: callbackify(syncApi.futimesSync, { minArgsBeforeCb: 3 }),
    fsync: callbackify(syncApi.fsyncSync),
    fdatasync: callbackify(syncApi.fdatasyncSync),
    opendir,
    Dir,
    openAsBlob(p, options = {}) {
      validateObject(options, 'options');
      const type = options.type || '';
      validateString(type, 'options.type');
      validatePathType(p);
      let data;
      try {
        data = syncApi.readFileSync(p);
      } catch {
        throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', 'Unable to open file as blob');
      }
      return Promise.resolve(new Blob([data], { type }));
    },
    _toUnixTimestamp: toUnixTimestamp,
    lchmod: undefined,
    lchmodSync: undefined,
    readv: vectored('readv', readBuffers, false),
    writev: vectored('writev', writeBuffers, true),
    symlink: callbackify(syncApi.symlinkSync, { minArgsBeforeCb: 2 }),
    readlink: callbackify(syncApi.readlinkSync),
    Stats,
    // Node 22's on Linux x86_64 (node_constants.cc), in its order.
    constants: {
      UV_FS_SYMLINK_DIR: 1,
      UV_FS_SYMLINK_JUNCTION: 2,
      O_RDONLY: 0,
      O_WRONLY: 1,
      O_RDWR: 2,
      UV_DIRENT_UNKNOWN: 0,
      UV_DIRENT_FILE: 1,
      UV_DIRENT_DIR: 2,
      UV_DIRENT_LINK: 3,
      UV_DIRENT_FIFO: 4,
      UV_DIRENT_SOCKET: 5,
      UV_DIRENT_CHAR: 6,
      UV_DIRENT_BLOCK: 7,
      S_IFMT,
      S_IFREG,
      S_IFDIR,
      S_IFCHR: 0o20000,
      S_IFBLK: 0o60000,
      S_IFIFO: 0o10000,
      S_IFLNK,
      S_IFSOCK: 0o140000,
      O_CREAT: 0o100,
      O_EXCL: 0o200,
      UV_FS_O_FILEMAP: 0,
      O_NOCTTY: 0o400,
      O_TRUNC: 0o1000,
      O_APPEND: 0o2000,
      O_DIRECTORY: 0o200000,
      O_NOATIME: 0o1000000,
      O_NOFOLLOW: 0o400000,
      O_SYNC: 0o4010000,
      O_DSYNC: 0o10000,
      O_DIRECT: 0o40000,
      O_NONBLOCK: 0o4000,
      S_IRWXU: 0o700,
      S_IRUSR: 0o400,
      S_IWUSR: 0o200,
      S_IXUSR: 0o100,
      S_IRWXG: 0o70,
      S_IRGRP: 0o40,
      S_IWGRP: 0o20,
      S_IXGRP: 0o10,
      S_IRWXO: 0o7,
      S_IROTH: 0o4,
      S_IWOTH: 0o2,
      S_IXOTH: 0o1,
      F_OK: 0,
      R_OK: 4,
      W_OK: 2,
      X_OK: 1,
      UV_FS_COPYFILE_EXCL: 1,
      COPYFILE_EXCL: 1,
      UV_FS_COPYFILE_FICLONE: 2,
      COPYFILE_FICLONE: 2,
      UV_FS_COPYFILE_FICLONE_FORCE: 4,
      COPYFILE_FICLONE_FORCE: 4,
    },
  };
  const statWatchers = createStatWatchers({
    process,
    path,
    handles,
    timers,
    stat: (target) => syncFs.stat(target),
    view: (st, bigint) => (st ? statView(st, bigint) : zeroStats(bigint)),
    errno: (code) => ERRNO[code] ?? ERRNO.EIO,
  });
  fsModule.watchFile = function watchFile(filename, options, listener) {
    validatePathType(filename);
    return statWatchers.watchFile(filename, options, listener);
  };
  fsModule.unwatchFile = function unwatchFile(filename, listener) {
    validatePathType(filename);
    return statWatchers.unwatchFile(filename, listener);
  };
  // slicc-kernel 1.125.0: file-change events for programs, registered when
  // ctx.sync.fs.watch returns (ai-ecoverse/slicc-kernel#1047). An older
  // kernel has none, and fs.watch stays out, as before.
  const fsWatch =
    typeof syncFs.watch === 'function'
      ? createFsWatch({
          process,
          path,
          Buffer,
          handles,
          timers,
          watch: (target, options, onNote) => syncFs.watch(target, options, onNote),
          barrier: () => asyncFs.stat('/'),
          stat: (target) => statView(syncFs.stat(target)),
          errno: (code) => ERRNO[code] ?? ERRNO.EIO,
          uvException: (errno, syscall, pathArg) => nodeFsError(ERRNO_NAMES[errno] ?? 'EIO', syscall, pathArg),
          validatedPath: (value, name) => getValidatedPath(value, name, { keepBuffer: true }),
          getOptions: (options) => {
            if (options == null || typeof options === 'function') return {};
            if (typeof options === 'string') options = { encoding: options };
            else if (typeof options !== 'object') throw ERR_INVALID_ARG_TYPE('options', ['string', 'Object'], options);
            // Node's assertEncoding: a falsy encoding is the default.
            if (options.encoding && options.encoding !== 'buffer') checkEncoding(options.encoding);
            if (options.signal !== undefined) validateAbortSignal(options.signal, 'options.signal');
            return options;
          },
          fs: () => fsModule,
          StatWatcher: statWatchers.StatWatcher,
        })
      : null;
  for (const [name, value] of Object.entries({ F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 })) {
    Object.defineProperty(fsModule, name, { enumerable: true, value });
  }
  for (const [legacy, name] of [['FileReadStream', 'ReadStream'], ['FileWriteStream', 'WriteStream']]) {
    let value = fsModule[name];
    Object.defineProperty(fsModule, legacy, {
      enumerable: true,
      configurable: true,
      get: () => value,
      set: (v) => {
        value = v;
      },
    });
  }
  promises.constants = fsModule.constants;
  acceptFileUrls(fsModule);
  acceptFileUrls(promises, { async: true, isHandle: (v) => fileHandles.has(v) });
  const Glob = () => process._nodeLib().fsGlob.Glob;
  fsModule.glob = function glob(pattern, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    validateFunction(callback, 'cb');
    track(
      (async () => {
        try {
          const res = [];
          for await (const entry of new (Glob())(pattern, options).glob()) res.push(entry);
          callback(null, res);
        } catch (err) {
          callback(err);
        }
      })()
    );
  };
  fsModule.globSync = function globSync(pattern, options) {
    return new (Glob())(pattern, options).globSync();
  };
  promises.glob = async function* glob(pattern, options) {
    yield* new (Glob())(pattern, options).glob();
  };
  // After acceptFileUrls: they take URLs themselves, after their options, as
  // Node's do, and promises.watch, an async generator, only when first iterated.
  if (fsWatch) {
    fsModule.watch = fsWatch.watch;
    promises.watch = fsWatch.promisesWatch;
  }
  // Not enumerable: require('fs') lists only Node's names.
  Object.defineProperty(fsModule, '_sliccOpenFile', { value: openFileOf });
  return fsModule;
}

/** lib/internal/url.js isURL: a WHATWG URL (not a legacy url.parse() result). */
const isURL = (self) => Boolean(self?.href && self.protocol && self.auth === undefined && self.path === undefined);

/** Functions whose first two arguments are paths (the rest: the first). */
// What ctx.sync.open refuses for the open itself (else the fd reads by its path).
const OPEN_REFUSALS = new Set(['EACCES', 'EPERM', 'EMFILE', 'ENFILE']);
const VALID_FLAGS = new Set(['r', 'rs', 'sr', 'r+', 'rs+', 'sr+', 'w', 'wx', 'xw', 'w+', 'wx+', 'xw+', 'a', 'ax', 'xa', 'as', 'sa', 'a+', 'ax+', 'xa+', 'as+', 'sa+']);
const TWO_PATHS = new Set(['rename', 'link', 'symlink', 'copyFile', 'cp']);
/** What Node's errors call those paths. */
const PATH_NAMES = {
  rename: ['oldPath', 'newPath'],
  link: ['existingPath', 'newPath'],
  symlink: ['target', 'path'],
  copyFile: ['src', 'dest'],
  cp: ['src', 'dest'],
  mkdtemp: ['prefix'],
};
const PATHLESS = /^(f[a-z]+|close|read|readv|write|writev|glob|lchmod|_toUnixTimestamp)(Sync)?$/;
const KEEPS_BUFFER = /^(readdir|opendir|createReadStream|createWriteStream|watchFile|unwatchFile)(Sync)?$/;
const TAKES_FD = /^(readFile|writeFile|appendFile|truncate)(Sync)?$/;
const STREAMS = /^create(Read|Write)Stream$/;

/**
 * Node's getValidatedPath / toPathIfFileURL: a path argument may be a
 * `file:` URL (its fileURLToPath, with Node's errors for another scheme, a
 * host, or an encoded `/`). Wraps each function of `api` in place.
 */
let fileURLToPath;
// Node's nullCheck: a path with a NUL byte, as a string, bytes or a URL.
const nullCheck = (value, name) => {
  const bad = typeof value === 'string' ? value.includes('\u0000') : value instanceof Uint8Array && value.includes(0);
  if (bad) throw ERR_INVALID_ARG_VALUE(name, value, 'must be a string, Uint8Array, or URL without null bytes');
  return value;
};
/** toPathIfFileURL, then nullCheck. */
function toPathArg(value, name) {
  if (!isURL(value)) return nullCheck(value, name);
  fileURLToPath ??= globalThis.process?._builtin?.('url').fileURLToPath;
  return nullCheck(fileURLToPath(value), name);
}
function getValidatedPath(value, name, { keepBuffer = false, fd = false, isHandle = null } = {}) {
  value = toPathArg(value, name);
  if ((fd && typeof value === 'number') || isHandle?.(value)) return value;
  if (typeof value !== 'string' && !(value instanceof Uint8Array)) throw ERR_INVALID_ARG_TYPE(name, ['string', 'Buffer', 'URL'], value);
  return keepBuffer ? value : pathString(value);
}

function acceptFileUrls(api, { async = false, isHandle = null } = {}) {
  const wrap = (name, fn, native = false) => {
    const base = name.replace(/Sync$/, '');
    const count = PATHLESS.test(name) ? 0 : TWO_PATHS.has(base) ? 2 : 1;
    const fd = TAKES_FD.test(name);
    const opts = { keepBuffer: KEEPS_BUFFER.test(name), fd: fd && !async, isHandle: fd && async ? isHandle : null };
    const stream = STREAMS.test(name);
    const coerces = !async && !native && base === 'realpath';
    const toPath = (value, argName) => getValidatedPath(coerces && !isURL(value) && typeof value !== 'string' ? `${value}` : value, argName, opts);
    // A path Node can't take: fs.promises rejects; exists / existsSync say
    // false (Node: callback(false)); the rest throw, as Node's do.
    const onBadPath = async
      ? (err) => Promise.reject(err)
      : name === 'existsSync'
        ? () => false
        : name === 'exists'
          ? (err, args) => (typeof args[1] === 'function' ? args[1](false) : undefined)
          : (err) => {
              throw err;
            };
    const wrapped = {
      [name](...args) {
        try {
          const names = (async && base === 'readlink' ? ['oldPath'] : PATH_NAMES[base]) ?? ['path'];
          const own = stream && args[1]?.fd != null;
          for (let i = 0; i < count && i < args.length && !own; i++) args[i] = toPath(args[i], names[i]);
        } catch (err) {
          return onBadPath(err, args);
        }
        return Reflect.apply(fn, this, args);
      },
    }[name];
    Object.defineProperty(wrapped, 'length', { value: fn.length });
    for (const key of Reflect.ownKeys(fn)) {
      if (key === 'length' || key === 'name' || key === 'prototype') continue;
      try {
        const d = Object.getOwnPropertyDescriptor(fn, key);
        // realpath.native / realpathSync.native take URLs too.
        if (key === 'native' && typeof d.value === 'function') d.value = wrap(name, d.value, true);
        Object.defineProperty(wrapped, key, d);
      } catch {
        /* non-configurable */
      }
    }
    return wrapped;
  };
  for (const name of Object.keys(api)) {
    const fn = api[name];
    if (typeof fn !== 'function' || /^[A-Z]/.test(name) || name === 'promises') continue;
    api[name] = wrap(name, fn);
  }
}
