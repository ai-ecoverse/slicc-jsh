/**
 * Node 22-ish CJS resolution over a sync FS (ctx.sync).
 * Covers relative paths, node_modules, package.json main/exports/imports,
 * .js/.cjs/.json, and directory index files.
 */
import { realpathWith } from '../realpath.mjs';
import { moduleNotFound, packagePathNotExported } from './errors.mjs';

// `slicc` first: a package can ship a build for slicc-kernel (for example a
// `sliccy-<name>` package that differs from its host build); host Node never
// sets it. See docs/design/run-outside-slicc.md.
const REQUIRE_CONDITIONS = ['slicc', 'require', 'node', 'default'];
const DEFAULT_EXTENSIONS = ['.js', '.cjs', '.json'];

export function createResolver({
  exposeInternals,
  fs,
  path,
  readPackageJson,
  conditions = REQUIRE_CONDITIONS,
  extensions = DEFAULT_EXTENSIONS,
  preserveSymlinks = false,
  esm = false,
} = {}) {
  /**
   * ESM mode (Node's ESM resolver): relative and absolute specifiers, export
   * targets and package subpaths name the exact file — no extensions, no
   * directory index. Failures throw an `esmResolveError` the ESM loader
   * words as Node does (it knows the importing module's URL).
   */
  const esmFail = (kind, value) => Object.assign(new Error(`${kind}: ${value}`), { esmResolveError: { kind, value } });
  // Node resolves a module to its real path (pnpm's node_modules/dep ->
  // .pnpm/dep@1/node_modules/dep), so its own requires resolve from where
  // it really lives; --preserve-symlinks / NODE_PRESERVE_SYMLINKS keep the
  // link path.
  const real = (filename) => {
    if (preserveSymlinks || typeof fs.lstat !== 'function' || typeof fs.readlink !== 'function') {
      return filename;
    }
    try {
      return realpathWith(fs, path, filename, (code) => Object.assign(new Error(code), { code }));
    } catch {
      return filename;
    }
  };
  const tryStat = (p) => {
    try {
      if (!fs.exists(p)) return null;
      return fs.stat(p);
    } catch {
      return null;
    }
  };

  const tryFile = (p) => {
    const st = tryStat(p);
    return st?.isFile ? p : null;
  };

  const tryExtensions = (p) => {
    if (tryFile(p)) return p;
    for (const ext of extensions) {
      const withExt = p + ext;
      if (tryFile(withExt)) return withExt;
    }
    return null;
  };

  const loadAsDirectory = (dir) => {
    const pkgPath = path.join(dir, 'package.json');
    if (tryFile(pkgPath)) {
      const pkg = readPackageJson(pkgPath);
      if (pkg?.exports !== undefined) {
        const resolved = resolveExports(pkg.exports, '.', pkgPath, dir);
        if (resolved) return resolved;
      }
      if (typeof pkg?.main === 'string') {
        const mainPath = path.resolve(dir, pkg.main);
        const asFile = tryExtensions(mainPath);
        if (asFile) return asFile;
        const asDir = loadAsDirectory(mainPath);
        if (asDir) return asDir;
      }
    }
    return tryExtensions(path.join(dir, 'index'));
  };

  /** ESM: the exact file, else ERR_UNSUPPORTED_DIR_IMPORT / ERR_MODULE_NOT_FOUND. */
  const exactFile = (p) => {
    const st = tryStat(p);
    if (st?.isFile) return p;
    if (st?.isDirectory) throw esmFail('dir', p);
    throw esmFail('module', p);
  };

  const loadAsFileOrDir = (p) => {
    if (esm) return exactFile(p);
    const asFile = tryExtensions(p);
    if (asFile) return asFile;
    const st = tryStat(p);
    if (st?.isDirectory) return loadAsDirectory(p);
    return null;
  };

  function matchExportTarget(target, pkgDir) {
    if (target === null) return null;
    if (typeof target === 'string') {
      if (!target.startsWith('./')) return null;
      return loadAsFileOrDir(path.resolve(pkgDir, target));
    }
    if (Array.isArray(target)) {
      for (const item of target) {
        const hit = matchExportTarget(item, pkgDir);
        if (hit) return hit;
      }
      return null;
    }
    if (typeof target === 'object') {
      for (const key of conditions) {
        if (Object.prototype.hasOwnProperty.call(target, key)) {
          const hit = matchExportTarget(target[key], pkgDir);
          if (hit) return hit;
        }
      }
      // Fallback: some packages use bare "." key only
      if (Object.prototype.hasOwnProperty.call(target, '.')) {
        return matchExportTarget(target['.'], pkgDir);
      }
    }
    return null;
  }

  function resolveExports(exportsField, subpath, pkgJsonPath, pkgDir) {
    if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
      if (subpath !== '.') throw packagePathNotExported(subpath, pkgJsonPath);
      return matchExportTarget(exportsField, pkgDir);
    }
    if (typeof exportsField !== 'object' || exportsField === null) return null;

    // Conditional exports at top level (no "." key) — treat as target for "."
    const keys = Object.keys(exportsField);
    const hasDotOrSlash = keys.some((k) => k === '.' || k.startsWith('./'));
    if (!hasDotOrSlash) {
      if (subpath !== '.') throw packagePathNotExported(subpath, pkgJsonPath);
      return matchExportTarget(exportsField, pkgDir);
    }

    const key = subpath === '.' ? '.' : subpath.startsWith('./') ? subpath : `./${subpath}`;
    if (Object.prototype.hasOwnProperty.call(exportsField, key)) {
      const hit = matchExportTarget(exportsField[key], pkgDir);
      if (hit) return hit;
      throw packagePathNotExported(subpath, pkgJsonPath);
    }

    // Pattern exports: "./features/*" → "./features/*.js"
    for (const [pattern, target] of Object.entries(exportsField)) {
      if (!pattern.includes('*')) continue;
      const [pre, post] = pattern.split('*');
      if (!key.startsWith(pre) || !key.endsWith(post ?? '')) continue;
      const star = key.slice(pre.length, key.length - (post?.length ?? 0));
      const mapped = mapStar(target, star);
      const hit = matchExportTarget(mapped, pkgDir);
      if (hit) return hit;
    }

    throw packagePathNotExported(subpath, pkgJsonPath);
  }

  function mapStar(target, star) {
    if (typeof target === 'string') return target.replaceAll('*', star);
    if (Array.isArray(target)) return target.map((t) => mapStar(t, star));
    if (target && typeof target === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(target)) out[k] = mapStar(v, star);
      return out;
    }
    return target;
  }

  const packageImportsResolve = (name, parentFilename) => {
    // Walk up for nearest package.json with "imports"
    let dir = path.dirname(parentFilename);
    for (;;) {
      const pkgPath = path.join(dir, 'package.json');
      if (tryFile(pkgPath)) {
        const pkg = readPackageJson(pkgPath);
        if (pkg?.imports && typeof pkg.imports === 'object') {
          const entry = pkg.imports[name];
          if (entry !== undefined) {
            const hit = matchExportTarget(entry, dir);
            if (hit) return hit;
            throw packagePathNotExported(name, pkgPath);
          }
          // Pattern imports: "#cfg/*" → "./cfg/*.js"
          for (const [pattern, target] of Object.entries(pkg.imports)) {
            if (!pattern.includes('*')) continue;
            const [pre, post] = pattern.split('*');
            if (!name.startsWith(pre) || !name.endsWith(post ?? '')) continue;
            const star = name.slice(pre.length, name.length - (post?.length ?? 0));
            const mapped = mapStar(target, star);
            const hit = matchExportTarget(mapped, dir);
            if (hit) return hit;
          }
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  };

  const nodeModulesPaths = (fromDir) => {
    const paths = [];
    let dir = fromDir;
    for (;;) {
      if (path.basename(dir) !== 'node_modules') {
        paths.push(path.join(dir, 'node_modules'));
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return paths;
  };

  const loadNodeModules = (request, fromDir) => {
    // Scoped packages: @scope/name[/sub]
    let pkgName;
    let subpath = '';
    if (request.startsWith('@')) {
      const parts = request.split('/');
      if (parts.length < 2) return null;
      pkgName = `${parts[0]}/${parts[1]}`;
      subpath = parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.';
    } else {
      const slash = request.indexOf('/');
      if (slash === -1) {
        pkgName = request;
        subpath = '.';
      } else {
        pkgName = request.slice(0, slash);
        subpath = `./${request.slice(slash + 1)}`;
      }
    }

    for (const nm of nodeModulesPaths(fromDir)) {
      const pkgDir = path.join(nm, pkgName);
      const st = tryStat(pkgDir);
      if (!st?.isDirectory) continue;
      const pkgPath = path.join(pkgDir, 'package.json');
      if (tryFile(pkgPath)) {
        const pkg = readPackageJson(pkgPath);
        if (pkg?.exports !== undefined) {
          return resolveExports(pkg.exports, subpath, pkgPath, pkgDir);
        }
      }
      if (subpath === '.') {
        const hit = loadAsDirectory(pkgDir);
        if (hit) return hit;
        if (esm) throw esmFail('module', pkgDir);
      } else {
        const hit = loadAsFileOrDir(path.resolve(pkgDir, subpath));
        if (hit) return hit;
      }
    }
    return null;
  };

  /**
   * @param {string} request
   * @param {string} parentFilename absolute path of the requiring module, or cwd for -e
   * @param {string[]} [stack]
   */
  function resolve(request, parentFilename, stack = []) {
    if (typeof request !== 'string' || request.length === 0) {
      throw moduleNotFound(request, stack);
    }

    if (request.startsWith('node:')) {
      return { type: 'builtin', id: request.slice('node:'.length) };
    }

    // Core builtins without node: prefix
    if (isBuiltinName(request)) {
      return { type: 'builtin', id: request };
    }
    // node --expose-internals: Node's internal modules (those the runtime has).
    if (request.startsWith('internal/') && exposeInternals?.()) {
      return { type: 'builtin', id: request };
    }

    const fromDir =
      parentFilename.endsWith('/') || tryStat(parentFilename)?.isDirectory
        ? parentFilename
        : path.dirname(parentFilename);

    if (request.startsWith('#')) {
      const hit = packageImportsResolve(request, parentFilename);
      if (hit) return { type: 'file', filename: real(hit) };
      throw moduleNotFound(request, stack);
    }

    if (request.startsWith('/') || request.startsWith('./') || request.startsWith('../')) {
      const abs = path.resolve(fromDir, request);
      const hit = loadAsFileOrDir(abs);
      if (hit) return { type: 'file', filename: real(hit) };
      throw moduleNotFound(request, stack);
    }

    const nm = loadNodeModules(request, fromDir);
    if (nm) return { type: 'file', filename: real(nm) };

    if (esm) throw esmFail('package', packageNameOf(request));
    throw moduleNotFound(request, stack);
  }

  return { resolve, tryFile, loadAsDirectory };
}

/** A bare specifier's package name (`@scope/name` or `name`). */
function packageNameOf(request) {
  const parts = request.split('/');
  return request.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const BUILTIN_NAMES = new Set([
  'assert',
  'assert/strict',
  'buffer',
  'console',
  'events',
  'fs',
  'fs/promises',
  'module',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'process',
  'punycode',
  'querystring',
  'stream',
  'stream/promises',
  'string_decoder',
  'timers',
  'timers/promises',
  'url',
  'util',
  'util/types',
  // Known but not-yet-supported: resolve as builtin so load() can throw ERR_NOT_SUPPORTED
  'child_process',
  'net',
  'http',
  'https',
  'http2',
  'crypto',
  'zlib',
  'readline',
  'readline/promises',
  'tty',
  'worker_threads',
  'dgram',
  'dns',
  'tls',
  'cluster',
  'vm',
]);

function isBuiltinName(name) {
  return BUILTIN_NAMES.has(name);
}

export { BUILTIN_NAMES, isBuiltinName };
