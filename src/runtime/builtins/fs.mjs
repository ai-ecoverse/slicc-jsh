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
};

function nodeFsError(code, syscall, pathArg, err) {
  const c = typeof code === 'string' ? code : err?.code || 'EIO';
  const desc = DESCRIPTIONS[c] || c;
  const e = new Error(`${c}: ${desc}, ${syscall} '${pathArg}'`);
  e.code = c;
  e.errno = ERRNO[c] ?? -1;
  e.syscall = syscall;
  e.path = pathArg;
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

export function createFs({ ctx, path, process, Buffer, handles }) {
  const abs = (p) => {
    if (typeof p === 'number') return p;
    return path.isAbsolute(p) ? path.normalize(p) : path.resolve(process.cwd(), p);
  };

  const syncFs = ctx.sync.fs;
  const asyncFs = ctx.fs;
  const wrapBuffer = (bytes) => (Buffer ? Buffer.from(bytes) : bytes);
  const track = (p) => (handles ? trackPromise(handles, p) : p);

  function readStdinSync(encoding) {
    // Best-effort: empty if no sync stdin; async path preferred via process.stdin.
    try {
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
      const target = abs(p);
      try {
        const bytes = syncFs.readFile(target);
        if (encoding) return decoder.decode(bytes);
        return wrapBuffer(bytes);
      } catch (err) {
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
        throw nodeFsError(err?.code || 'ENOENT', 'rename', from, err);
      }
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
            throw nodeFsError(err?.code || 'ENOENT', 'rename', from, err);
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
  };

  return {
    ...syncApi,
    promises,
    Dirent,
    readFile: callbackify(syncApi.readFileSync),
    writeFile: callbackify(syncApi.writeFileSync),
    appendFile: callbackify(syncApi.appendFileSync),
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
