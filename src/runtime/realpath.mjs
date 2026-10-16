/**
 * Node's JS realpath (lib/fs.js realpathSync) over the kernel's sync fs:
 * every symlink along an absolute path resolved, left to right.
 *
 * `fs` has lstat(p) → { isSymbolicLink }, stat(p) and readlink(p) on
 * absolute paths; `fail(code, syscall, path, err)` makes the error thrown.
 */
import { createPath } from './path.mjs';

export const MAX_LINKS = 40;

/**
 * `cache` (a Map), when given, is Node's realpathCache (lib/fs.js
 * realpathSync with internalFS.realpathCacheKey): a path prefix that is no
 * link maps to itself, a link to what it resolved to, and the whole path to
 * its result. The module loaders keep one for the process, as Node's do
 * (it is never cleared), so a module's real path costs one lstat per new
 * directory, not one per component on every resolution.
 */
export function realpathWith(fs, path, p, fail, cache) {
  const original = path.resolve(String(p));
  const cached = cache?.get(original);
  if (cached !== undefined) return cached;
  let resolved = original;
  const knownHard = new Set();
  let hops = 0;
  let current = '/';
  let pos = 1;
  const call = (fn, syscall, at) => {
    try {
      return fn();
    } catch (err) {
      throw fail(err?.code || 'ENOENT', syscall, at, err);
    }
  };
  while (pos < resolved.length) {
    const next = resolved.indexOf('/', pos);
    const part = next === -1 ? resolved.slice(pos) : resolved.slice(pos, next);
    pos = next === -1 ? resolved.length : next + 1;
    if (!part) continue;
    const previous = current;
    const base = current === '/' ? `/${part}` : `${current}/${part}`;
    current = base;
    if (knownHard.has(base) || cache?.get(base) === base) continue;
    let link = cache?.get(base);
    if (link === undefined) {
      const st = call(() => fs.lstat(base), 'lstat', base);
      if (!st.isSymbolicLink) {
        knownHard.add(base);
        cache?.set(base, base);
        continue;
      }
      if (++hops > MAX_LINKS) throw fail('ELOOP', 'stat', base);
      // Node stats the link first, so a dangling or looping one fails here.
      call(() => fs.stat(base), 'stat', base);
      link = path.resolve(previous, call(() => fs.readlink(base), 'readlink', base));
      cache?.set(base, link);
    }
    resolved = path.resolve(link, resolved.slice(pos));
    current = '/';
    pos = 1;
  }
  cache?.set(original, resolved);
  return resolved;
}

/** The entry's real path, unless --preserve-symlinks-main (Node). */
export function realMainPath(ctx, filePath, execArgv = []) {
  if (execArgv.includes('--preserve-symlinks-main')) return filePath;
  const fs = ctx?.sync?.fs;
  if (typeof fs?.lstat !== 'function' || typeof fs?.readlink !== 'function') return filePath;
  try {
    return realpathWith(fs, createPath(() => ctx.cwd), filePath, (code) => Object.assign(new Error(code), { code }));
  } catch {
    return filePath;
  }
}

