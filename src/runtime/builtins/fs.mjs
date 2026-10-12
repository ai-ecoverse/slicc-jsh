/**
 * Node-like fs / fs/promises over ctx.sync (sync) and ctx.fs (promises).
 * Async ops are tracked as ref'd handles so the event loop stays alive.
 */
import { trackPromise } from '../async-handles.mjs';
import { createCp } from './fs-cp.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ERRNO = {
  ENOENT: -2,
  EEXIST: -17,
  EISDIR: -21,
  ENOTDIR: -20,
  EPERM: -1,
  EACCES: -13,
  EINVAL: -22,
  EIO: -5,
  ENOTEMPTY: -39, // Linux (the shim's process.platform)
  EBADF: -9,
  ENOTSUP: -45,
  EXDEV: -18,
  ELOOP: -40,
};

const DESCRIPTIONS = {
  ENOENT: 'no such file or directory',
  EEXIST: 'file already exists',
  EISDIR: 'illegal operation on a directory',
  ENOTDIR: 'not a directory',
  EPERM: 'operation not permitted',
  EACCES: 'permission denied',
  EINVAL: 'invalid argument',
  EIO: 'i/o error',
  ENOTEMPTY: 'directory not empty',
  EBADF: 'bad file descriptor',
  ENOTSUP: 'operation not supported',
  EXDEV: 'cross-device link not permitted',
  ELOOP: 'too many symbolic links encountered',
};

function nodeFsError(code, syscall, pathArg, err, dest) {
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
  const type = st.isDirectory ? S_IFDIR : st.isSymbolicLink ? S_IFLNK : S_IFREG;
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

export function createFs({ ctx, path, process, Buffer, handles, getStream }) {
  const abs = (p) => {
    if (typeof p === 'number') return p;
    return path.isAbsolute(p) ? path.normalize(p) : path.resolve(process.cwd(), p);
  };

  const syncFs = ctx.sync.fs;
  const asyncFs = ctx.fs;
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
    const f = flags == null ? 'r' : String(flags);
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

  function writeBytesAtPath(ent, bytes, filePosition) {
    let cur = new Uint8Array(0);
    try {
      cur = syncFs.readFile(ent.path);
    } catch {
      cur = new Uint8Array(0);
    }
    const pos =
      filePosition == null
        ? ent.flags.includes('a')
          ? cur.length
          : ent.pos
        : filePosition;
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
    if (!recursive) {
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
        if (st && !st.isDirectory) throw nodeFsError('ENOTDIR', 'mkdir', pathArg);
        continue;
      }
      try {
        syncFs.mkdir(cur);
        firstAbs ??= cur;
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
        return names.map((name) => dirent(name, typeAt(path.join(target, name)), String(pathArg)));
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

  const syncApi = {
    readFileSync(p, options) {
      const encoding = optEncoding(options);
      checkEncoding(encoding);
      if (p === 0 || p === '0') return readStdinSync(encoding);
      if (typeof p === 'number') {
        const ent = fdTable.get(p);
        if (!ent || !ent.readable) throw nodeFsError('EBADF', 'read', undefined);
        try {
          const bytes = syncFs.readFile(ent.path);
          const rest = bytes.subarray(Math.min(ent.pos, bytes.length));
          ent.pos += rest.length;
          return decodeAs(rest, encoding);
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
      const bytes = encodeAs(data, optEncoding(options));
      const flag = optFlag(options, 'w');
      // A descriptor: write at its position (stdout/stderr included).
      if (typeof p === 'number') {
        syncApi.writeSync(p, bytes);
        return;
      }
      if (flag.includes('a')) {
        syncApi.appendFileSync(p, bytes);
        return;
      }
      const pathArg = p;
      const target = abs(p);
      if (flag.includes('x') && syncFs.exists(target)) throw nodeFsError('EEXIST', 'open', pathArg);
      if (flag.startsWith('r')) {
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
        syncFs.writeFile(target, bytes);
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'open', pathArg, err);
      }
    },
    appendFileSync(p, data, options) {
      const next = encodeAs(data, optEncoding(options));
      // A flag other than append (Node allows any) writes as writeFileSync does.
      const flag = optFlag(options, 'a');
      if (!flag.includes('a')) {
        syncApi.writeFileSync(p, next, { flag });
        return;
      }
      if (typeof p === 'number') {
        const ent = fdTable.get(p);
        let end = null;
        if (ent) {
          try {
            end = syncFs.stat(ent.path).size ?? 0;
          } catch {
            end = 0;
          }
        }
        syncApi.writeSync(p, next, 0, next.length, end);
        return;
      }
      const pathArg = p;
      const target = abs(p);
      try {
        let prev = new Uint8Array(0);
        if (syncFs.exists(target)) prev = syncFs.readFile(target);
        const merged = new Uint8Array(prev.length + next.length);
        merged.set(prev);
        merged.set(next, prev.length);
        syncFs.writeFile(target, merged);
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'open', pathArg, err);
      }
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
    lstatSync(p, options) {
      const pathArg = p;
      try {
        return statView(syncFs.lstat(abs(p)), options?.bigint === true);
      } catch (err) {
        const code = err?.code || 'ENOENT';
        if (options?.throwIfNoEntry === false && (code === 'ENOENT' || code === 'ENOTDIR')) return undefined;
        throw nodeFsError(code, 'lstat', pathArg, err);
      }
    },
    /** Node's JS realpath: every symlink along the path resolved. */
    realpathSync(p, options) {
      const real = getCp().realpathSync(abs(p));
      return optEncoding(options) === 'buffer' ? wrapBuffer(encoder.encode(real)) : real;
    },
    readdirSync,
    mkdirSync,
    // The kernel's rm is recursive: only ever hand it an empty directory.
    rmdirSync(p, options = {}) {
      const pathArg = p;
      const target = abs(p);
      let st;
      try {
        st = syncFs.lstat(target);
      } catch (err) {
        throw nodeFsError(err?.code || 'ENOENT', 'rmdir', pathArg, err);
      }
      // Even with `recursive`, rmdir removes directories only (Node).
      if (!st.isDirectory) throw nodeFsError('ENOTDIR', 'rmdir', pathArg);
      if (options?.recursive) {
        syncApi.rmSync(p, { recursive: true, force: options.force });
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
    rmSync(p, options = {}) {
      const pathArg = p;
      const target = abs(p);
      let st;
      try {
        st = syncFs.lstat(target);
      } catch (err) {
        if (options?.force && (err?.code === 'ENOENT' || err?.code === 'ENOTDIR')) return;
        throw nodeFsError(err?.code || 'ENOENT', 'lstat', pathArg, err);
      }
      if (st.isDirectory && !options?.recursive) throw rmIsDirectoryError(pathArg);
      try {
        if (st.isDirectory) {
          for (const name of syncFs.readdir(target)) {
            syncApi.rmSync(path.join(target, name), { recursive: true, force: options.force });
          }
          syncFs.rm(target);
        } else {
          syncFs.unlink(target);
        }
      } catch (err) {
        if (err?.syscall) throw err;
        throw nodeFsError(err?.code || 'EIO', 'rm', pathArg, err);
      }
    },
    unlinkSync(p) {
      const pathArg = p;
      try {
        syncFs.unlink(abs(p));
      } catch (err) {
        throw nodeFsError(err?.code || 'ENOENT', 'unlink', pathArg, err);
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
      void mode;
      const pathArg = p;
      if (pathArg === '/dev/stdin' || pathArg === '/dev/fd/0') {
        return 0;
      }
      const fl = parseFlags(flags);
      const target = abs(p);
      const exists = syncFs.exists(target);
      if (fl.exclusive && exists) throw nodeFsError('EEXIST', 'open', pathArg);
      if (!exists) {
        if (!fl.create) throw nodeFsError('ENOENT', 'open', pathArg);
        try {
          syncFs.writeFile(target, new Uint8Array(0));
        } catch (err) {
          throw nodeFsError(err?.code || 'EIO', 'open', pathArg, err);
        }
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
      const fd = nextFd++;
      fdTable.set(fd, {
        path: target,
        flags: fl.raw,
        pos,
        readable: fl.readable || fl.raw === 'r',
        writable: fl.writable,
      });
      return fd;
    },
    readSync(fd, buffer, offset, length, position) {
      const { bufOffset, length: len, position: filePosition } = parseReadSyncArgs(
        buffer,
        offset,
        length,
        position
      );
      if (fd === 0) {
        const data = readStdinSync(null);
        const src = data instanceof Uint8Array ? data : encoder.encode(String(data));
        const n = Math.min(len, src.length);
        buffer.set(src.subarray(0, n), bufOffset);
        return n;
      }
      const ent = fdTable.get(fd);
      if (!ent || !ent.readable) throw nodeFsError('EBADF', 'read', undefined);
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
      if (fd === 1 || fd === 2) {
        const { bytes } = parseWriteSyncArgs(data, offset, length, position);
        ctx.sync.write(fd, bytes);
        return bytes.byteLength;
      }
      const ent = fdTable.get(fd);
      // A descriptor opened read-only cannot be written (Node: EBADF).
      if (!ent || !ent.writable) throw nodeFsError('EBADF', 'write', undefined);
      const { bytes, filePosition } = parseWriteSyncArgs(data, offset, length, position);
      try {
        return writeBytesAtPath(ent, bytes, filePosition);
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'write', ent.path, err);
      }
    },
    fstatSync(fd, options) {
      const ent = fdTable.get(fd);
      if (!ent) throw nodeFsError('EBADF', 'fstat', undefined);
      try {
        return statView(syncFs.stat(ent.path), options?.bigint === true);
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'fstat', ent.path, err);
      }
    },
    ftruncateSync(fd, len = 0) {
      const ent = fdTable.get(fd);
      if (!ent) throw nodeFsError('EBADF', 'ftruncate', undefined);
      try {
        let cur = syncFs.readFile(ent.path);
        if (len < cur.length) cur = cur.subarray(0, len);
        else if (len > cur.length) {
          const out = new Uint8Array(len);
          out.set(cur, 0);
          cur = out;
        }
        syncFs.writeFile(ent.path, cur);
        if (ent.pos > len) ent.pos = len;
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'ftruncate', ent.path, err);
      }
    },
    closeSync(fd) {
      if (fd === 0 || fd === 1 || fd === 2) return;
      if (!fdTable.has(fd)) throw nodeFsError('EBADF', 'close', undefined);
      fdTable.delete(fd);
    },
    symlinkSync(target, p) {
      try {
        syncFs.symlink(target, abs(p));
      } catch (err) {
        // Node names both: symlink 'target' -> 'path'.
        throw nodeFsError(err?.code || 'EIO', 'symlink', target, err, p);
      }
    },
    readlinkSync(p) {
      try {
        return syncFs.readlink(abs(p));
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
          syncFs.mkdir(target);
        } catch (err) {
          throw nodeFsError(err?.code || 'ENOENT', 'mkdtemp', `${prefix}XXXXXX`, err);
        }
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
    // The kernel's JS fs has no mode bits, owners or times to set: these
    // check that the path exists, as Node's do, and change nothing.
    chmodSync(p) {
      mustExist(p, 'chmod');
    },
    lchmodSync(p) {
      mustExist(p, 'lchmod');
    },
    fchmodSync(fd) {
      syncApi.fstatSync(fd);
    },
    chownSync(p) {
      mustExist(p, 'chown');
    },
    lchownSync(p) {
      mustExist(p, 'lchown');
    },
    fchownSync(fd) {
      syncApi.fstatSync(fd);
    },
    utimesSync(p) {
      mustExist(p, 'utime');
    },
    lutimesSync(p) {
      mustExist(p, 'lutime');
    },
    futimesSync(fd) {
      syncApi.fstatSync(fd);
    },
    fsyncSync(fd) {
      if (fd !== 0 && fd !== 1 && fd !== 2 && !fdTable.has(fd)) throw nodeFsError('EBADF', 'fsync', undefined);
    },
    fdatasyncSync(fd) {
      if (fd !== 0 && fd !== 1 && fd !== 2 && !fdTable.has(fd)) throw nodeFsError('EBADF', 'fdatasync', undefined);
    },
    opendirSync(p, options) {
      let entries;
      try {
        entries = readdirSync(p, { withFileTypes: true, recursive: options?.recursive === true }, { followLinks: false });
      } catch (err) {
        // Node's opendir errors name the syscall, not the path.
        throw nodeFsError(err?.code || 'ENOENT', 'opendir', undefined, err);
      }
      return createDir(String(p), entries);
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

  /** Node's fs.Dir over a listing taken when it was opened. */
  function createDir(dirPath, entries) {
    let closed = false;
    const next = () => {
      if (closed) {
        const e = new Error('Directory handle was closed');
        e.code = 'ERR_DIR_CLOSED';
        throw e;
      }
      return entries.length ? entries.shift() : null;
    };
    return {
      path: dirPath,
      readSync: next,
      read(cb) {
        if (typeof cb === 'function') {
          queueMicrotask(() => {
            try {
              cb(null, next());
            } catch (err) {
              cb(err);
            }
          });
          return undefined;
        }
        return Promise.resolve().then(next);
      },
      closeSync() {
        if (closed) next();
        closed = true;
      },
      close(cb) {
        let err = null;
        if (closed) {
          try {
            next();
          } catch (e) {
            err = e;
          }
        }
        closed = true;
        if (typeof cb === 'function') {
          queueMicrotask(() => cb(err));
          return undefined;
        }
        return err ? Promise.reject(err) : Promise.resolve();
      },
      async *[Symbol.asyncIterator]() {
        try {
          for (let d = next(); d; d = next()) yield d;
        } finally {
          closed = true;
        }
      },
    };
  }

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
        queueMicrotask(() => cb(err));
      }
    };
  }

  const promises = {
    readFile(p, options) {
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
      return track((async () => syncApi.rmSync(p, options))());
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
    chmod(p) {
      return track((async () => syncApi.chmodSync(p))());
    },
    lchmod(p) {
      return track((async () => syncApi.lchmodSync(p))());
    },
    chown(p) {
      return track((async () => syncApi.chownSync(p))());
    },
    lchown(p) {
      return track((async () => syncApi.lchownSync(p))());
    },
    utimes(p) {
      return track((async () => syncApi.utimesSync(p))());
    },
    lutimes(p) {
      return track((async () => syncApi.lutimesSync(p))());
    },
    opendir(p, options) {
      return track((async () => syncApi.opendirSync(p, options))());
    },
    unlink(p) {
      return track(
        (async () => {
          try {
            await asyncFs.unlink(abs(p));
          } catch (err) {
            throw nodeFsError(err?.code || 'ENOENT', 'unlink', p, err);
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
    readlink(p) {
      return track(
        (async () => {
          return asyncFs.readlink(abs(p));
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
      if (closed || !fdTable.has(fd)) throw nodeFsError('EBADF', syscall, undefined);
    };
    const entPath = () => fdTable.get(fd)?.path;

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
      async write(data, offset, length, position) {
        ensureOpen('write');
        const bytesWritten = syncApi.writeSync(fd, data, offset, length, position);
        return { bytesWritten, buffer: data };
      },
      async writeFile(data, options) {
        ensureOpen('writeFile');
        syncApi.writeFileSync(entPath(), data, options);
      },
      async appendFile(data, options) {
        ensureOpen('appendFile');
        syncApi.appendFileSync(entPath(), data, options);
      },
      async stat() {
        ensureOpen('stat');
        return syncApi.statSync(entPath());
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
      async chmod() {
        ensureOpen('fchmod');
      },
      async chown() {
        ensureOpen('fchown');
      },
      async utimes() {
        ensureOpen('futimes');
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
    return handle;
  }

  function openStreamFd(p, flags, options, onOpen, onError) {
    try {
      const fileFd = options?.fd != null ? options.fd : syncApi.openSync(p, flags);
      onOpen(fileFd);
    } catch (err) {
      onError(err);
    }
  }

  function createReadStream(p, options = {}) {
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

    const r = new Readable({
      highWaterMark,
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
            if (autoClose && fd != null && fd !== 0) syncApi.closeSync(fd);
            return;
          }
          const buf = Buffer.alloc(toRead);
          const n = syncApi.readSync(fd, buf, 0, toRead, pos);
          r.bytesRead += n;
          if (n === 0) {
            this.push(null);
            if (autoClose && fd != null && fd !== 0) syncApi.closeSync(fd);
            return;
          }
          pos += n;
          const chunk = buf.subarray(0, n);
          this.push(encoding ? chunk.toString(encoding) : chunk);
        } catch (err) {
          this.destroy(err);
        }
      },
    });
    r.path = p;
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
    const stream = getStream?.();
    if (!stream) throw new Error('fs.createWriteStream: stream not available');
    const { Writable } = stream;
    const highWaterMark = options?.highWaterMark ?? 64 * 1024;
    let fd = options?.fd;
    let autoClose = options?.autoClose !== false;
    let opened = fd != null;
    let openEmitted = opened;
    const flags = options?.flags ?? 'w';

    const w = new Writable({
      highWaterMark,
      write(chunk, enc, cb) {
        try {
          if (!opened) {
            fd = syncApi.openSync(p, flags);
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
        try {
          if (autoClose && fd != null && fd !== 0 && fd !== 1 && fd !== 2) syncApi.closeSync(fd);
          cb();
        } catch (err) {
          cb(err);
        }
      },
    });
    w.path = p;
    w.bytesWritten = 0;
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
  function ReadStream(p, options) {
    return createReadStream(p, options);
  }
  Object.defineProperty(ReadStream, Symbol.hasInstance, { value: (x) => !!x?.[FS_READ_STREAM] });
  function WriteStream(p, options) {
    return createWriteStream(p, options);
  }
  Object.defineProperty(WriteStream, Symbol.hasInstance, { value: (x) => !!x?.[FS_WRITE_STREAM] });

  return {
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
      if (typeof cb === 'function') return callbackify(syncApi.rmSync)(p, opts ?? {}, cb);
      let err = null;
      try {
        syncApi.rmSync(p, opts ?? {});
      } catch (e) {
        err = e;
      }
      void err;
      // A macrotask later, as the thread pool would answer.
      setTimeout(() => {
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
    lchmod: callbackify(syncApi.lchmodSync, { minArgsBeforeCb: 2 }),
    fchmod: callbackify(syncApi.fchmodSync, { minArgsBeforeCb: 2 }),
    chown: callbackify(syncApi.chownSync, { minArgsBeforeCb: 3 }),
    lchown: callbackify(syncApi.lchownSync, { minArgsBeforeCb: 3 }),
    fchown: callbackify(syncApi.fchownSync, { minArgsBeforeCb: 3 }),
    utimes: callbackify(syncApi.utimesSync, { minArgsBeforeCb: 3 }),
    lutimes: callbackify(syncApi.lutimesSync, { minArgsBeforeCb: 3 }),
    futimes: callbackify(syncApi.futimesSync, { minArgsBeforeCb: 3 }),
    fsync: callbackify(syncApi.fsyncSync),
    fdatasync: callbackify(syncApi.fdatasyncSync),
    opendir: callbackify(syncApi.opendirSync),
    symlink: callbackify(syncApi.symlinkSync, { minArgsBeforeCb: 2 }),
    readlink: callbackify(syncApi.readlinkSync),
    Stats,
    constants: {
      F_OK: 0,
      R_OK: 4,
      W_OK: 2,
      X_OK: 1,
      O_RDONLY: 0,
      O_WRONLY: 1,
      O_RDWR: 2,
      O_CREAT: 0o100,
      O_TRUNC: 0o1000,
      O_APPEND: 0o2000,
      O_EXCL: 0o200,
      S_IFMT,
      S_IFREG,
      S_IFDIR,
      S_IFLNK,
      COPYFILE_EXCL: 1,
      COPYFILE_FICLONE: 2,
      COPYFILE_FICLONE_FORCE: 4,
    },
  };
}
