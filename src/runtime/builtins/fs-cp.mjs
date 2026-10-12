/**
 * fs.cp / fs.cpSync / fs.promises.cp and fs.realpath, as Node 22.22 does them.
 *
 * Node has two implementations with different details, and both are copied
 * here:
 * - cpSync: lib/internal/fs/cp/cp-sync.js over the C++ checks in
 *   src/node_file.cc (CpSyncCheckPaths, CpSyncCopyDir), which word their
 *   errors differently and copy a directory's symlinks as symlinks even with
 *   `dereference`;
 * - cp and promises.cp: lib/internal/fs/cp/cp.js, whose errors are
 *   SystemErrors and whose `dereference` does dereference.
 *
 * Common to both: a symlink is copied as a symlink (its target made absolute
 * unless `verbatimSymlinks`), a symlinked directory is never descended into,
 * and nothing outside the source tree is read or written through a link.
 */

import { realpathWith } from '../realpath.mjs';

const ERRNO = { EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22 };

const SYSTEM_ERROR_PREFIX = {
  ERR_FS_CP_DIR_TO_NON_DIR: 'Cannot overwrite non-directory with directory',
  ERR_FS_CP_EEXIST: 'Target already exists',
  ERR_FS_CP_EINVAL: 'Invalid src or dest',
  ERR_FS_CP_NON_DIR_TO_DIR: 'Cannot overwrite directory with non-directory',
  ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY: 'Cannot overwrite symlink in subdirectory of self',
  ERR_FS_EISDIR: 'Path is a directory',
};

/** Node's SystemError (internal/errors.js) for the cp.js family. */
function systemError(key, { message, path, code }) {
  const err = new Error(
    `${SYSTEM_ERROR_PREFIX[key]}: cp returned ${code} (${message})${path === undefined ? '' : ` ${path}`}`
  );
  err.name = 'SystemError';
  err.code = key;
  err.errno = ERRNO[code];
  err.syscall = 'cp';
  if (path !== undefined) err.path = path;
  err.info = { code, message, path, syscall: 'cp', errno: ERRNO[code] };
  return err;
}

/** What node_file.cc's THROW_ERR_* macros throw: a plain Error with a code. */
function nativeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function invalidFilterReturn() {
  const err = new TypeError(
    'Expected boolean to be returned from the "filter" function but got an instance of Promise.'
  );
  err.code = 'ERR_INVALID_RETURN_VALUE';
  return err;
}

const isPromise = (v) => v != null && typeof v.then === 'function';

/**
 * @param {object} deps
 * @param {object} deps.path    the runtime's path module
 * @param {object} deps.ops     raw kernel calls (absolute paths) and helpers:
 *   lstat(p), stat(p) → { isFile, isDirectory, isSymbolicLink, ino, dev }
 *   readlink(p), symlink(target, p), readdir(p), mkdir(p), unlink(p)
 * @param {(p: string) => string} deps.abs    absolute path for a user path
 * @param {Function} deps.fsError  (code, syscall, path, err, dest) → Node error
 * @param {Function} deps.copyFileSync  the fs module's (validating) copyFileSync
 * @param {Function} deps.mkdirpSync   mkdir -p
 */
export function createCp({ path, ops, abs, fsError, copyFileSync, mkdirpSync }) {
  const tryCall = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  // A kernel call, its error worded as Node's for `syscall` and `pathArg`.
  const call = (fn, syscall, pathArg, dest) => {
    try {
      return fn();
    } catch (err) {
      if (err?.syscall) throw err;
      throw fsError(err?.code || 'EIO', syscall, pathArg, err, dest);
    }
  };
  const lstat = (p) => call(() => ops.lstat(abs(p)), 'lstat', p);
  const stat = (p) => call(() => ops.stat(abs(p)), 'stat', p);
  const readlink = (p) => call(() => ops.readlink(abs(p)), 'readlink', p);
  const symlink = (target, p) => call(() => ops.symlink(target, abs(p)), 'symlink', target, p);
  const unlink = (p) => call(() => ops.unlink(abs(p)), 'unlink', p);
  const readdir = (p) => call(() => ops.readdir(abs(p)), 'scandir', p);
  const exists = (p) => !!tryCall(() => ops.stat(abs(p)));

  // ---- realpath (lib/fs.js realpathSync) -----------------------------------

  const realpathSync = (p) => realpathWith(ops, path, p, (code, syscall, at, err) => fsError(code, syscall, at, err));

  // std::filesystem::weakly_canonical: the existing prefix made canonical,
  // the rest appended as is.
  function weaklyCanonical(p) {
    const parts = path.resolve(p).split('/').filter(Boolean);
    for (let i = parts.length; i > 0; i--) {
      const prefix = `/${parts.slice(0, i).join('/')}`;
      if (!exists(prefix)) continue;
      const real = tryCall(() => realpathSync(prefix)) ?? prefix;
      return path.join(real, ...parts.slice(i));
    }
    return path.resolve(p);
  }

  const equivalent = (a, b) => {
    if (!exists(a) || !exists(b)) return false;
    return tryCall(() => realpathSync(a)) === tryCall(() => realpathSync(b));
  };

  const normalizeArray = (p) => path.resolve(p).split('/').filter(Boolean);
  const isSrcSubdir = (src, dest) => {
    const s = normalizeArray(src);
    const d = normalizeArray(dest);
    return s.every((cur, i) => d[i] === cur);
  };

  const withDefaults = (options = {}) => ({
    dereference: false,
    errorOnExist: false,
    force: true,
    preserveTimestamps: false,
    recursive: false,
    verbatimSymlinks: false,
    mode: 0,
    ...options,
  });

  // ---- cpSync (cp-sync.js + node_file.cc) -----------------------------------

  function checkPathsSync(src, dest, dereference, recursive) {
    // node_file.cc picks symlink_status / status the other way round from
    // what the flag says, and names the syscall to match: kept as Node has it.
    const srcSt = call(() => (dereference ? ops.lstat(abs(src)) : ops.stat(abs(src))), dereference ? 'stat' : 'lstat', src);
    const destSt = tryCall(() => (dereference ? ops.stat(abs(dest)) : ops.lstat(abs(dest))));
    const srcIsDir = !!srcSt.isDirectory || (dereference && !!srcSt.isSymbolicLink);
    if (destSt) {
      if (equivalent(src, dest)) throw nativeError('ERR_FS_CP_EINVAL', `src and dest cannot be the same ${dest}`);
      const destIsDir = !!destSt.isDirectory;
      if (srcIsDir && !destIsDir) {
        throw nativeError('ERR_FS_CP_DIR_TO_NON_DIR', `Cannot overwrite non-directory ${dest} with directory ${src}`);
      }
      if (!srcIsDir && destIsDir) {
        throw nativeError('ERR_FS_CP_NON_DIR_TO_DIR', `Cannot overwrite directory ${dest} with non-directory ${src}`);
      }
    }
    const srcSlash = src.endsWith('/') ? src : `${src}/`;
    const subdir = () =>
      nativeError('ERR_FS_CP_EINVAL', `Cannot copy ${srcSlash} to a subdirectory of self ${dest}`);
    if (srcIsDir && dest.startsWith(srcSlash)) throw subdir();
    if (path.dirname(src) !== path.dirname(dest) && equivalent(src, path.dirname(dest))) throw subdir();
    if (srcIsDir && !recursive) {
      throw nativeError('ERR_FS_EISDIR', `Recursive option not enabled, cannot copy a directory: ${srcSlash}`);
    }
    if (!destSt || !exists(path.dirname(dest))) tryCall(() => mkdirpSync(path.dirname(dest)));
  }

  function getStatsSync(src, dest, opts) {
    const srcSt = opts.dereference ? stat(src) : lstat(src);
    const destSt = tryCall(() => (opts.dereference ? ops.stat(abs(dest)) : ops.lstat(abs(dest))));
    if (srcSt.isDirectory && opts.recursive) return copyDirSync(src, dest, opts, !destSt);
    if (srcSt.isSymbolicLink) return onLinkSync(destSt, src, dest, opts.verbatimSymlinks);
    if (!destSt) return copyFileSync(src, dest, opts.mode);
    if (opts.force) {
      unlink(dest);
      return copyFileSync(src, dest, opts.mode);
    }
    if (opts.errorOnExist) {
      throw systemError('ERR_FS_CP_EEXIST', { message: `${dest} already exists`, path: dest, code: 'EEXIST' });
    }
    return undefined;
  }

  function copyDirSync(src, dest, opts, mkDir) {
    if (!opts.filter) return nativeCopyDir(src, dest, opts);
    if (mkDir) call(() => ops.mkdir(abs(dest)), 'mkdir', dest);
    for (const name of readdir(src)) {
      const srcItem = path.join(src, name);
      const destItem = path.join(dest, name);
      const shouldCopy = opts.filter(srcItem, destItem);
      if (isPromise(shouldCopy)) throw invalidFilterReturn();
      if (shouldCopy) getStatsSync(srcItem, destItem, opts);
    }
    return undefined;
  }

  // node_file.cc CpSyncCopyDir.
  function nativeCopyDir(src, dest, opts) {
    call(() => mkdirpSync(dest), 'cp', dest);
    const walk = (srcDir, destDir) => {
      for (const name of readdir(srcDir)) {
        const srcItem = path.join(srcDir, name);
        const destItem = path.join(destDir, name);
        const st = lstat(srcItem);
        if (st.isSymbolicLink) {
          const target = readlink(srcItem);
          if (opts.verbatimSymlinks) {
            if (tryCall(() => ops.lstat(abs(destItem)))) throw fsError('EEXIST', 'cp', destDir);
            symlink(target, destItem);
            continue;
          }
          if (exists(destItem)) {
            const destLink = tryCall(() => ops.lstat(abs(destItem)));
            if (destLink?.isSymbolicLink) {
              unlink(destItem);
            } else if (!stat(destItem).isDirectory) {
              if (!opts.dereference || (!opts.force && opts.errorOnExist)) {
                throw fsError('EEXIST', 'cp', destItem);
              }
            }
          } else if (tryCall(() => ops.lstat(abs(destItem)))?.isSymbolicLink) {
            unlink(destItem);
          }
          symlink(weaklyCanonical(path.resolve(srcDir, target)), destItem);
        } else if (st.isDirectory) {
          if (!tryCall(() => ops.lstat(abs(destItem)))) call(() => ops.mkdir(abs(destItem)), 'cp', destDir);
          walk(srcItem, destItem);
        } else {
          const there = tryCall(() => ops.lstat(abs(destItem)));
          if (there) {
            if (opts.force) {
              unlink(destItem);
            } else if (opts.errorOnExist) {
              throw nativeError(
                'ERR_FS_CP_EEXIST',
                `[ERR_FS_CP_EEXIST]: Target already exists: cp returned EEXIST (${destItem} already exists)`
              );
            } else {
              continue;
            }
          }
          copyFileSync(srcItem, destItem);
        }
      }
    };
    walk(src, dest);
  }

  function onLinkSync(destSt, src, dest, verbatimSymlinks) {
    let resolvedSrc = readlink(src);
    if (!verbatimSymlinks && !path.isAbsolute(resolvedSrc)) resolvedSrc = path.resolve(path.dirname(src), resolvedSrc);
    if (!destSt) return symlink(resolvedSrc, dest);
    let resolvedDest;
    try {
      resolvedDest = readlink(dest);
    } catch (err) {
      if (err.code === 'EINVAL' || err.code === 'UNKNOWN') return symlink(resolvedSrc, dest);
      throw err;
    }
    if (!path.isAbsolute(resolvedDest)) resolvedDest = path.resolve(path.dirname(dest), resolvedDest);
    if (isSrcSubdir(resolvedSrc, resolvedDest)) {
      throw systemError('ERR_FS_CP_EINVAL', {
        message: `cannot copy ${resolvedSrc} to a subdirectory of self ${resolvedDest}`,
        path: dest,
        code: 'EINVAL',
      });
    }
    if (tryCall(() => ops.stat(abs(dest)))?.isDirectory && isSrcSubdir(resolvedDest, resolvedSrc)) {
      throw systemError('ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY', {
        message: `cannot overwrite ${resolvedDest} with ${resolvedSrc}`,
        path: dest,
        code: 'EINVAL',
      });
    }
    unlink(dest);
    return symlink(resolvedSrc, dest);
  }

  function cpSync(src, dest, options) {
    const opts = withDefaults(options);
    src = String(src);
    dest = String(dest);
    if (opts.filter) {
      const shouldCopy = opts.filter(src, dest);
      if (isPromise(shouldCopy)) throw invalidFilterReturn();
      if (!shouldCopy) return;
    }
    checkPathsSync(src, dest, opts.dereference, opts.recursive);
    getStatsSync(src, dest, opts);
  }

  // ---- cp / promises.cp (cp.js) ---------------------------------------------

  // cp.js compares dev/ino; where the kernel leaves them out, compare the
  // resolved paths instead.
  const sameFile = (a, aPath, b, bPath) => {
    if (a?.ino && a?.dev && b?.ino && b?.dev) return a.ino === b.ino && a.dev === b.dev;
    return equivalent(aPath, bPath);
  };

  async function cp(src, dest, options) {
    const opts = withDefaults(options);
    src = String(src);
    dest = String(dest);
    const checked = await checkPaths(src, dest, opts);
    if (checked.skipped) return;
    checkParentPaths(src, checked.srcStat, dest);
    if (!exists(path.dirname(dest))) mkdirpSync(path.dirname(dest));
    await copyEntry(checked.destStat, src, dest, opts);
  }

  async function checkPaths(src, dest, opts) {
    if (opts.filter && !(await opts.filter(src, dest))) return { skipped: true };
    const statFn = opts.dereference ? stat : lstat;
    const srcStat = statFn(src);
    let destStat = null;
    try {
      destStat = statFn(dest);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (destStat) {
      if (sameFile(srcStat, src, destStat, dest)) {
        throw systemError('ERR_FS_CP_EINVAL', { message: 'src and dest cannot be the same', path: dest, code: 'EINVAL' });
      }
      if (srcStat.isDirectory && !destStat.isDirectory) {
        throw systemError('ERR_FS_CP_DIR_TO_NON_DIR', {
          message: `cannot overwrite non-directory ${dest} with directory ${src}`,
          path: dest,
          code: 'EISDIR',
        });
      }
      if (!srcStat.isDirectory && destStat.isDirectory) {
        throw systemError('ERR_FS_CP_NON_DIR_TO_DIR', {
          message: `cannot overwrite directory ${dest} with non-directory ${src}`,
          path: dest,
          code: 'ENOTDIR',
        });
      }
    }
    if (srcStat.isDirectory && isSrcSubdir(src, dest)) {
      throw systemError('ERR_FS_CP_EINVAL', {
        message: `cannot copy ${src} to a subdirectory of self ${dest}`,
        path: dest,
        code: 'EINVAL',
      });
    }
    return { srcStat, destStat, skipped: false };
  }

  function checkParentPaths(src, srcStat, dest) {
    const srcParent = path.resolve(path.dirname(src));
    const destParent = path.resolve(path.dirname(dest));
    if (destParent === srcParent || destParent === '/') return;
    const destStat = tryCall(() => ops.stat(destParent));
    if (!destStat) return;
    const same = sameFile(srcStat, src, destStat, destParent);
    if (same) {
      throw systemError('ERR_FS_CP_EINVAL', {
        message: `cannot copy ${src} to a subdirectory of self ${dest}`,
        path: dest,
        code: 'EINVAL',
      });
    }
    checkParentPaths(src, srcStat, destParent);
  }

  async function copyEntry(destStat, src, dest, opts) {
    const srcStat = opts.dereference ? stat(src) : lstat(src);
    if (srcStat.isDirectory && opts.recursive) {
      if (!destStat) call(() => ops.mkdir(abs(dest)), 'mkdir', dest);
      for (const name of readdir(src)) {
        const srcItem = path.join(src, name);
        const destItem = path.join(dest, name);
        const checked = await checkPaths(srcItem, destItem, opts);
        if (!checked.skipped) await copyEntry(checked.destStat, srcItem, destItem, opts);
      }
      return;
    }
    if (srcStat.isDirectory) {
      throw systemError('ERR_FS_EISDIR', { message: `${src} is a directory (not copied)`, path: src, code: 'EISDIR' });
    }
    if (srcStat.isSymbolicLink) {
      let resolvedSrc = readlink(src);
      if (!opts.verbatimSymlinks && !path.isAbsolute(resolvedSrc)) {
        resolvedSrc = path.resolve(path.dirname(src), resolvedSrc);
      }
      if (!destStat) {
        symlink(resolvedSrc, dest);
        return;
      }
      let resolvedDest;
      try {
        resolvedDest = readlink(dest);
      } catch (err) {
        if (err.code === 'EINVAL' || err.code === 'UNKNOWN') {
          symlink(resolvedSrc, dest);
          return;
        }
        throw err;
      }
      if (!path.isAbsolute(resolvedDest)) resolvedDest = path.resolve(path.dirname(dest), resolvedDest);
      if (isSrcSubdir(resolvedSrc, resolvedDest)) {
        throw systemError('ERR_FS_CP_EINVAL', {
          message: `cannot copy ${resolvedSrc} to a subdirectory of self ${resolvedDest}`,
          path: dest,
          code: 'EINVAL',
        });
      }
      if (tryCall(() => ops.stat(abs(src)))?.isDirectory && isSrcSubdir(resolvedDest, resolvedSrc)) {
        throw systemError('ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY', {
          message: `cannot overwrite ${resolvedDest} with ${resolvedSrc}`,
          path: dest,
          code: 'EINVAL',
        });
      }
      unlink(dest);
      symlink(resolvedSrc, dest);
      return;
    }
    if (!destStat) {
      copyFileSync(src, dest, opts.mode);
      return;
    }
    if (opts.force) {
      unlink(dest);
      copyFileSync(src, dest, opts.mode);
    } else if (opts.errorOnExist) {
      throw systemError('ERR_FS_CP_EEXIST', { message: `${dest} already exists`, path: dest, code: 'EEXIST' });
    }
  }

  return { cpSync, cp, realpathSync, weaklyCanonical };
}
