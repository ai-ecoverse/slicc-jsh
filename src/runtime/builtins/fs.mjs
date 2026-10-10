/**
 * Node-like fs / fs/promises over ctx.sync (sync) and ctx.fs (promises).
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function errnoError(err, syscall, path) {
  const code = err?.code || err?.errno || 'EIO';
  const e = new Error(`${syscall} '${path}': ${code}`);
  e.code = typeof code === 'string' ? code : 'EIO';
  e.errno = e.code;
  e.syscall = syscall;
  e.path = path;
  return e;
}

function toBytes(data, encoding) {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return encoder.encode(String(data));
}

function fromBytes(bytes, encoding) {
  if (encoding === undefined || encoding === null) {
    // Return Buffer if available on the factory; else Uint8Array
    return bytes;
  }
  return decoder.decode(bytes);
}

function statView(st) {
  return {
    isFile: () => !!st.isFile,
    isDirectory: () => !!st.isDirectory,
    isSymbolicLink: () => !!st.isSymbolicLink,
    size: st.size,
    mode: st.mode,
    mtimeMs: st.mtimeMs,
    atimeMs: st.atimeMs,
    ctimeMs: st.ctimeMs,
    ino: st.ino,
    dev: st.dev,
  };
}

export function createFs({ ctx, path, process, Buffer }) {
  const abs = (p) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(process.cwd(), p));

  const syncFs = ctx.sync.fs;
  const asyncFs = ctx.fs;

  const wrapBuffer = (bytes) => (Buffer ? Buffer.from(bytes) : bytes);

  function mkdirSync(p, options = {}) {
    const target = abs(p);
    const recursive = options === true || options?.recursive === true;
    if (!recursive) {
      try {
        syncFs.mkdir(target);
      } catch (err) {
        throw errnoError(err, 'mkdir', target);
      }
      return;
    }
    const parts = target.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += `/${part}`;
      if (syncFs.exists(cur)) continue;
      try {
        syncFs.mkdir(cur);
      } catch (err) {
        if (err?.code === 'EEXIST') continue;
        throw errnoError(err, 'mkdir', cur);
      }
    }
  }

  const syncApi = {
    readFileSync(p, options) {
      const target = abs(p);
      const encoding = typeof options === 'string' ? options : options?.encoding;
      try {
        const bytes = syncFs.readFile(target);
        if (encoding) return decoder.decode(bytes);
        return wrapBuffer(bytes);
      } catch (err) {
        throw errnoError(err, 'open', target);
      }
    },
    writeFileSync(p, data, options) {
      const target = abs(p);
      const encoding = typeof options === 'string' ? options : options?.encoding;
      try {
        syncFs.writeFile(target, toBytes(data, encoding));
      } catch (err) {
        throw errnoError(err, 'open', target);
      }
    },
    appendFileSync(p, data, options) {
      const target = abs(p);
      const encoding = typeof options === 'string' ? options : options?.encoding;
      try {
        let prev = new Uint8Array(0);
        if (syncFs.exists(target)) prev = syncFs.readFile(target);
        const next = toBytes(data, encoding);
        const merged = new Uint8Array(prev.length + next.length);
        merged.set(prev);
        merged.set(next, prev.length);
        syncFs.writeFile(target, merged);
      } catch (err) {
        throw errnoError(err, 'open', target);
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
      const target = abs(p);
      try {
        return statView(syncFs.stat(target));
      } catch (err) {
        throw errnoError(err, 'stat', target);
      }
    },
    lstatSync(p) {
      const target = abs(p);
      try {
        return statView(syncFs.lstat(target));
      } catch (err) {
        throw errnoError(err, 'lstat', target);
      }
    },
    readdirSync(p) {
      const target = abs(p);
      try {
        return syncFs.readdir(target);
      } catch (err) {
        throw errnoError(err, 'scandir', target);
      }
    },
    mkdirSync,
    rmSync(p, options = {}) {
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
        throw errnoError(err, 'rm', target);
      }
    },
    unlinkSync(p) {
      const target = abs(p);
      try {
        syncFs.unlink(target);
      } catch (err) {
        throw errnoError(err, 'unlink', target);
      }
    },
    renameSync(from, to) {
      const a = abs(from);
      const b = abs(to);
      try {
        syncFs.rename(a, b);
      } catch (err) {
        throw errnoError(err, 'rename', a);
      }
    },
    symlinkSync(target, p) {
      const link = abs(p);
      try {
        syncFs.symlink(target, link);
      } catch (err) {
        throw errnoError(err, 'symlink', link);
      }
    },
    readlinkSync(p) {
      const target = abs(p);
      try {
        return syncFs.readlink(target);
      } catch (err) {
        throw errnoError(err, 'readlink', target);
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
    async readFile(p, options) {
      const target = abs(p);
      const encoding = typeof options === 'string' ? options : options?.encoding;
      const bytes = await asyncFs.readFile(target);
      if (encoding) return decoder.decode(bytes);
      return wrapBuffer(bytes);
    },
    async writeFile(p, data, options) {
      const target = abs(p);
      const encoding = typeof options === 'string' ? options : options?.encoding;
      await asyncFs.writeFile(target, toBytes(data, encoding));
    },
    async appendFile(p, data, options) {
      const target = abs(p);
      let prev = new Uint8Array(0);
      if (await asyncFs.exists(target)) prev = await asyncFs.readFile(target);
      const next = toBytes(data, typeof options === 'string' ? options : options?.encoding);
      const merged = new Uint8Array(prev.length + next.length);
      merged.set(prev);
      merged.set(next, prev.length);
      await asyncFs.writeFile(target, merged);
    },
    async stat(p) {
      return statView(await asyncFs.stat(abs(p)));
    },
    async lstat(p) {
      return statView(await asyncFs.lstat(abs(p)));
    },
    async readdir(p) {
      return asyncFs.readdir(abs(p));
    },
    async mkdir(p, options = {}) {
      const target = abs(p);
      if (options?.recursive) {
        const parts = target.split('/').filter(Boolean);
        let cur = '';
        for (const part of parts) {
          cur += `/${part}`;
          if (await asyncFs.exists(cur)) continue;
          try {
            await asyncFs.mkdir(cur);
          } catch (err) {
            if (err?.code !== 'EEXIST') throw err;
          }
        }
        return;
      }
      await asyncFs.mkdir(target);
    },
    async rm(p, options = {}) {
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
        throw err;
      }
    },
    async unlink(p) {
      await asyncFs.unlink(abs(p));
    },
    async rename(from, to) {
      await asyncFs.rename(abs(from), abs(to));
    },
    async symlink(target, p) {
      await asyncFs.symlink(target, abs(p));
    },
    async readlink(p) {
      return asyncFs.readlink(abs(p));
    },
    async access(p) {
      if (!(await asyncFs.exists(abs(p)))) {
        const err = new Error(`ENOENT: no such file or directory, access '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
    },
  };

  return {
    ...syncApi,
    promises,
    readFile: callbackify(syncApi.readFileSync),
    writeFile: callbackify(syncApi.writeFileSync),
    appendFile: callbackify(syncApi.appendFileSync),
    exists: (p, cb) => queueMicrotask(() => cb(syncApi.existsSync(p))),
    stat: callbackify(syncApi.statSync),
    lstat: callbackify(syncApi.lstatSync),
    readdir: callbackify(syncApi.readdirSync),
    mkdir: callbackify(syncApi.mkdirSync),
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
