/** Minimal POSIX `path` (from slicc 6 realm helpers, Apache-2.0). */

function normalizeArray(parts, allowAboveRoot) {
  const res = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (res.length > 0 && res[res.length - 1] !== '..') res.pop();
      else if (allowAboveRoot) res.push('..');
    } else {
      res.push(part);
    }
  }
  return res;
}

function normalize(path) {
  if (path.length === 0) return '.';
  const isAbsolute = path.charCodeAt(0) === 47;
  const trailingSep = path.charCodeAt(path.length - 1) === 47;
  let out = normalizeArray(path.split('/'), !isAbsolute).join('/');
  if (out.length === 0 && !isAbsolute) out = '.';
  if (out.length > 0 && trailingSep) out += '/';
  return (isAbsolute ? '/' : '') + out;
}

function join(...parts) {
  const joined = parts.filter((p) => typeof p === 'string' && p.length > 0).join('/');
  if (joined.length === 0) return '.';
  return normalize(joined);
}

function dirname(path) {
  if (path.length === 0) return '.';
  const hasRoot = path.charCodeAt(0) === 47;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; i--) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? '/' : '.';
  return path.slice(0, end);
}

function basename(path, ext) {
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  const base = end === -1 ? '' : path.slice(start, end);
  if (ext && base.endsWith(ext) && base !== ext) return base.slice(0, base.length - ext.length);
  return base;
}

function extname(path) {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot);
}

function resolve(getCwd, parts) {
  let resolved = '';
  let isAbsolute = false;
  for (let i = parts.length - 1; i >= -1 && !isAbsolute; i--) {
    const part = i >= 0 ? parts[i] : getCwd();
    if (typeof part !== 'string' || part.length === 0) continue;
    resolved = resolved.length > 0 ? `${part}/${resolved}` : part;
    isAbsolute = part.charCodeAt(0) === 47;
  }
  const normalized = normalizeArray(resolved.split('/'), !isAbsolute).join('/');
  if (isAbsolute) return normalized.length > 0 ? `/${normalized}` : '/';
  return normalized.length > 0 ? normalized : '.';
}

export function createPath(getCwd = () => '/') {
  return {
    sep: '/',
    delimiter: ':',
    basename,
    dirname,
    extname,
    isAbsolute: (path) => path.length > 0 && path.charCodeAt(0) === 47,
    join,
    normalize,
    resolve: (...parts) => resolve(getCwd, parts),
    relative(from, to) {
      const fromAbs = resolve(getCwd, [from]);
      const toAbs = resolve(getCwd, [to]);
      if (fromAbs === toAbs) return '';
      const fromParts = fromAbs.split('/').filter(Boolean);
      const toParts = toAbs.split('/').filter(Boolean);
      let i = 0;
      while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
      return [...fromParts.slice(i).map(() => '..'), ...toParts.slice(i)].join('/');
    },
  };
}
