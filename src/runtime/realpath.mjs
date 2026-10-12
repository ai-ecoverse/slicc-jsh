/**
 * Node's JS realpath (lib/fs.js realpathSync) over the kernel's sync fs:
 * every symlink along an absolute path resolved, left to right.
 *
 * `fs` has lstat(p) → { isSymbolicLink }, stat(p) and readlink(p) on
 * absolute paths; `fail(code, syscall, path, err)` makes the error thrown.
 */
export const MAX_LINKS = 40;

export function realpathWith(fs, path, p, fail) {
  let resolved = path.resolve(String(p));
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
    if (knownHard.has(base)) continue;
    const st = call(() => fs.lstat(base), 'lstat', base);
    if (!st.isSymbolicLink) {
      knownHard.add(base);
      continue;
    }
    if (++hops > MAX_LINKS) throw fail('ELOOP', 'stat', base);
    // Node stats the link first, so a dangling or looping one fails here.
    call(() => fs.stat(base), 'stat', base);
    const target = call(() => fs.readlink(base), 'readlink', base);
    resolved = path.resolve(previous, target, resolved.slice(pos));
    current = '/';
    pos = 1;
  }
  return resolved;
}
