/**
 * Node-like fs / fs/promises over ctx.sync (sync) and ctx.fs (promises).
 * Async ops are tracked as ref'd handles so the event loop stays alive.
 */
import { trackPromise } from '../async-handles.mjs';

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
  ENOTEMPTY: -66,
  EBADF: -9,
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

function toBytes(data) {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return encoder.encode(String(data));
}

function statView(st) {
  const mtimeMs = st.mtimeMs ?? (st.mtime ? Number(st.mtime) : 0);
  const atimeMs = st.atimeMs ?? mtimeMs;
  const ctimeMs = st.ctimeMs ?? mtimeMs;
  return {
    isFile: () => !!st.isFile,
    isDirectory: () => !!st.isDirectory,
    isSymbolicLink: () => !!st.isSymbolicLink,
    size: st.size ?? 0,
    mode: st.mode,
    mtimeMs,
    atimeMs,
    ctimeMs,
    mtime: new Date(mtimeMs),
    atime: new Date(atimeMs),
    ctime: new Date(ctimeMs),
    birthtime: new Date(ctimeMs),
    ino: st.ino,
    dev: st.dev,
  };
}

class Dirent {
  constructor(name, type) {
    this.name = name;
    this._type = type; // 'file' | 'dir' | 'link' | 'unknown'
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
        const out = process._readStdinSync();
        return encoding ? decoder.decode(out) : wrapBuffer(out);
      }
      if (typeof process?.stdin?._readAllSync === 'function') {
        const out = process.stdin._readAllSync();
        return encoding ? decoder.decode(out) : wrapBuffer(out);
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
        return encoding ? decoder.decode(out) : wrapBuffer(out);
      }
    } catch {
      /* fall through */
    }
    return encoding ? '' : wrapBuffer(new Uint8Array(0));
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
    const parts = String(target).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += `/${part}`;
      if (syncFs.exists(cur)) continue;
      try {
        syncFs.mkdir(cur);
      } catch (err) {
        if (err?.code === 'EEXIST') continue;
        throw nodeFsError(err?.code || 'EIO', 'mkdir', pathArg, err);
      }
    }
  }

  function readdirSync(p, options) {
    const pathArg = p;
    const target = abs(p);
    try {
      const names = syncFs.readdir(target);
      if (options?.withFileTypes) {
        return names.map((name) => {
          let type = 'unknown';
          try {
            const st = syncFs.lstat(path.join(target, name));
            type = st.isDirectory ? 'dir' : st.isSymbolicLink ? 'link' : st.isFile ? 'file' : 'unknown';
          } catch {
            /* ignore */
          }
          return new Dirent(name, type);
        });
      }
      return names;
    } catch (err) {
      throw nodeFsError(err?.code || 'ENOENT', 'scandir', pathArg, err);
    }
  }

  const syncApi = {
    readFileSync(p, options) {
      const encoding = typeof options === 'string' ? options : options?.encoding;
      if (p === 0 || p === '0') return readStdinSync(encoding);
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
        const bytes = syncFs.readFile(target);
        if (encoding) return decoder.decode(bytes);
        return wrapBuffer(bytes);
      } catch (err) {
        if (err?.code && err.syscall) throw err;
        throw nodeFsError(err?.code || 'ENOENT', 'open', pathArg, err);
      }
    },
    writeFileSync(p, data, options) {
      const pathArg = p;
      const target = abs(p);
      void options;
      try {
        syncFs.writeFile(target, toBytes(data));
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'open', pathArg, err);
      }
    },
    appendFileSync(p, data, options) {
      const pathArg = p;
      const target = abs(p);
      void options;
      try {
        let prev = new Uint8Array(0);
        if (syncFs.exists(target)) prev = syncFs.readFile(target);
        const next = toBytes(data);
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
    statSync(p) {
      const pathArg = p;
      try {
        return statView(syncFs.stat(abs(p)));
      } catch (err) {
        throw nodeFsError(err?.code || 'ENOENT', 'stat', pathArg, err);
      }
    },
    lstatSync(p) {
      const pathArg = p;
      try {
        return statView(syncFs.lstat(abs(p)));
      } catch (err) {
        throw nodeFsError(err?.code || 'ENOENT', 'lstat', pathArg, err);
      }
    },
    readdirSync,
    mkdirSync,
    rmdirSync(p, options = {}) {
      const pathArg = p;
      const target = abs(p);
      try {
        if (options.recursive) {
          syncApi.rmSync(p, { recursive: true, force: options.force });
          return;
        }
        syncFs.rm(target);
      } catch (err) {
        throw nodeFsError(err?.code || 'ENOENT', 'rmdir', pathArg, err);
      }
    },
    rmSync(p, options = {}) {
      const pathArg = p;
      const target = abs(p);
      try {
        const st = syncFs.lstat(target);
        if (st.isDirectory) {
          if (options.recursive) {
            for (const name of syncFs.readdir(target)) {
              syncApi.rmSync(path.join(target, name), { recursive: true, force: options.force });
            }
          }
          syncFs.rm(target);
        } else {
          syncFs.unlink(target);
        }
      } catch (err) {
        if (options.force && (err?.code === 'ENOENT' || !syncFs.exists(target))) return;
        throw nodeFsError(err?.code || 'ENOENT', 'rm', pathArg, err);
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
      if (!ent) throw nodeFsError('EBADF', 'read', undefined);
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
      if (!ent) throw nodeFsError('EBADF', 'write', undefined);
      const { bytes, filePosition } = parseWriteSyncArgs(data, offset, length, position);
      try {
        return writeBytesAtPath(ent, bytes, filePosition);
      } catch (err) {
        throw nodeFsError(err?.code || 'EIO', 'write', ent.path, err);
      }
    },
    fstatSync(fd) {
      const ent = fdTable.get(fd);
      if (!ent) throw nodeFsError('EBADF', 'fstat', undefined);
      try {
        return statView(syncFs.stat(ent.path));
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
        throw nodeFsError(err?.code || 'EIO', 'symlink', p, err);
      }
    },
    readlinkSync(p) {
      try {
        return syncFs.readlink(abs(p));
      } catch (err) {
        throw nodeFsError(err?.code || 'ENOENT', 'readlink', p, err);
      }
    },
  };

  function callbackify(fn) {
    return (...args) => {
      const cb = args.pop();
      try {
        const result = fn(...args);
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
          const encoding = typeof options === 'string' ? options : options?.encoding;
          try {
            const bytes = await asyncFs.readFile(abs(p));
            if (encoding) return decoder.decode(bytes);
            return wrapBuffer(bytes);
          } catch (err) {
            throw nodeFsError(err?.code || 'ENOENT', 'open', p, err);
          }
        })()
      );
    },
    writeFile(p, data, options) {
      return track(
        (async () => {
          void options;
          try {
            await asyncFs.writeFile(abs(p), toBytes(data));
          } catch (err) {
            throw nodeFsError(err?.code || 'EIO', 'open', p, err);
          }
        })()
      );
    },
    appendFile(p, data, options) {
      return track(
        (async () => {
          void options;
          const target = abs(p);
          let prev = new Uint8Array(0);
          if (await asyncFs.exists(target)) prev = await asyncFs.readFile(target);
          const next = toBytes(data);
          const merged = new Uint8Array(prev.length + next.length);
          merged.set(prev);
          merged.set(next, prev.length);
          await asyncFs.writeFile(target, merged);
        })()
      );
    },
    stat(p) {
      return track(
        (async () => {
          try {
            return statView(await asyncFs.stat(abs(p)));
          } catch (err) {
            throw nodeFsError(err?.code || 'ENOENT', 'stat', p, err);
          }
        })()
      );
    },
    lstat(p) {
      return track(
        (async () => {
          try {
            return statView(await asyncFs.lstat(abs(p)));
          } catch (err) {
            throw nodeFsError(err?.code || 'ENOENT', 'lstat', p, err);
          }
        })()
      );
    },
    readdir(p, options) {
      return track(
        (async () => {
          try {
            const names = await asyncFs.readdir(abs(p));
            if (options?.withFileTypes) {
              const out = [];
              for (const name of names) {
                let type = 'unknown';
                try {
                  const st = await asyncFs.lstat(path.join(abs(p), name));
                  type = st.isDirectory ? 'dir' : st.isSymbolicLink ? 'link' : st.isFile ? 'file' : 'unknown';
                } catch {
                  /* ignore */
                }
                out.push(new Dirent(name, type));
              }
              return out;
            }
            return names;
          } catch (err) {
            throw nodeFsError(err?.code || 'ENOENT', 'scandir', p, err);
          }
        })()
      );
    },
    mkdir(p, options = {}) {
      return track(
        (async () => {
          const target = abs(p);
          if (options?.recursive) {
            const parts = String(target).split('/').filter(Boolean);
            let cur = '';
            for (const part of parts) {
              cur += `/${part}`;
              if (await asyncFs.exists(cur)) continue;
              try {
                await asyncFs.mkdir(cur);
              } catch (err) {
                if (err?.code !== 'EEXIST') throw nodeFsError(err?.code || 'EIO', 'mkdir', p, err);
              }
            }
            return;
          }
          if (await asyncFs.exists(target)) throw nodeFsError('EEXIST', 'mkdir', p);
          await asyncFs.mkdir(target);
        })()
      );
    },
    rm(p, options = {}) {
      return track(
        (async () => {
          const target = abs(p);
          try {
            const st = await asyncFs.lstat(target);
            if (st.isDirectory) {
              if (options.recursive) {
                for (const name of await asyncFs.readdir(target)) {
                  await promises.rm(path.join(target, name), { recursive: true, force: options.force });
                }
              }
              await asyncFs.rm(target);
            } else {
              await asyncFs.unlink(target);
            }
          } catch (err) {
            if (options.force && err?.code === 'ENOENT') return;
            throw nodeFsError(err?.code || 'ENOENT', 'rm', p, err);
          }
        })()
      );
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
      async close() {
        ensureOpen('close');
        closed = true;
        syncApi.closeSync(fd);
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

  return {
    ...syncApi,
    promises,
    Dirent,
    createReadStream,
    createWriteStream,
    readFile: callbackify(syncApi.readFileSync),
    writeFile: callbackify(syncApi.writeFileSync),
    appendFile: callbackify(syncApi.appendFileSync),
    open: callbackify(syncApi.openSync),
    close: callbackify(syncApi.closeSync),
    read(fd, buffer, offset, length, position, callback) {
      const parsed = parseReadCallbackArgs(buffer, offset, length, position, callback);
      queueMicrotask(() => {
        try {
          const bytesRead = syncApi.readSync(
            fd,
            buffer,
            parsed.bufOffset,
            parsed.length,
            parsed.position
          );
          parsed.callback(null, bytesRead, buffer);
        } catch (err) {
          parsed.callback(err);
        }
      });
    },
    write(fd, data, offset, length, position, callback) {
      const parsed = parseWriteCallbackArgs(data, offset, length, position, callback);
      queueMicrotask(() => {
        try {
          const written = syncApi.writeSync(fd, data, ...parsed.syncArgs);
          parsed.callback(null, written, data);
        } catch (err) {
          parsed.callback(err);
        }
      });
    },
    fstat: callbackify(syncApi.fstatSync),
    exists: (p, cb) => queueMicrotask(() => cb(syncApi.existsSync(p))),
    stat: callbackify(syncApi.statSync),
    lstat: callbackify(syncApi.lstatSync),
    readdir: callbackify(syncApi.readdirSync),
    mkdir: callbackify(syncApi.mkdirSync),
    rmdir: callbackify(syncApi.rmdirSync),
    unlink: callbackify(syncApi.unlinkSync),
    rename: callbackify(syncApi.renameSync),
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
    },
  };
}
