/**
 * `sliccy:<name>` resolution, the same in both engines:
 *
 * 1. names built into slicc-jsh (`cli`, `color`, `exec`, `fmt`, `http`,
 *    `pool`, `skill`, `time`);
 * 2. `@ai-ecoverse/sliccy-<name>`, then `sliccy-<name>`, found with Node's
 *    algorithm from the script's directory, then from slicc-jsh's own
 *    location (so a global install next to a global `jsh` is found), then
 *    from each of pnpm's global installs (`pnpm add -g`; see globalRoots);
 * 3. an error: names that exist only inside SLICC say so, others list what
 *    is known and the package to install.
 */
import { createExec, createSkill } from './exec.mjs';
import { createHttp } from './http.mjs';
import { colorEnabled, createCli, createColor, fmt, pool, time } from './pure.mjs';

const SLICC_ONLY = new Set(['agent', 'usb', 'serial', 'hid', 'computer']);

function isNotFound(err, request) {
  return err?.code === 'MODULE_NOT_FOUND' && String(err.message).includes(`'${request}'`);
}

/**
 * The names `import('sliccy:x')` exports, in both engines: `default` (the
 * module's value, as `require` returns it) and each own enumerable key of it.
 * Sorted, as a module namespace's are.
 */
export function sliccyExportNames(value) {
  const names = value !== null && (typeof value === 'object' || typeof value === 'function') ? Object.keys(value) : [];
  return ['default', ...names.filter((k) => k !== 'default')].sort();
}

/** A module namespace for a sliccy: module (the kernel engine's import()). */
export function sliccyNamespace(value) {
  const ns = Object.create(null);
  for (const name of sliccyExportNames(value)) {
    Object.defineProperty(ns, name, {
      value: name === 'default' ? value : value[name],
      enumerable: true,
      writable: true,
      configurable: false,
    });
  }
  Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' });
  return Object.preventExtensions(ns);
}

export function createSliccyResolver({ engine, process, require }) {
  let color;
  let exec;
  const getColor = () => {
    color ??= createColor(colorEnabled(process.env, engine.stdoutIsTTY));
    return color;
  };
  const getExec = () => {
    exec ??= createExec(engine);
    return exec;
  };

  const factories = {
    cli: () =>
      createCli({
        writeStdout: engine.writeStdout,
        writeStderr: engine.writeStderr,
        exit: (code) => process.exit(code),
        color: getColor(),
      }),
    color: getColor,
    exec: getExec,
    fmt: () => fmt,
    http: () => createHttp({ fetch: engine.fetch }),
    pool: () => pool,
    skill: () => createSkill({ argv: process.argv, fs: require('fs'), exec: getExec() }),
    time: () => time,
  };
  const cache = new Map();
  let globals;
  const lookups = {
    *[Symbol.iterator]() {
      if (require) yield require;
      if (engine.selfRequire) yield engine.selfRequire;
      globals ??= globalRequires(engine, process, require);
      yield* globals;
    },
  };

  return function requireSliccy(id) {
    const name = id.slice('sliccy:'.length);
    if (name === '') throw new Error("require('sliccy:'): empty sliccy: module name");
    if (cache.has(name)) return cache.get(name);
    let value;
    if (Object.prototype.hasOwnProperty.call(factories, name)) {
      value = factories[name]();
    } else {
      value = findPackage(name, lookups);
    }
    if (value === undefined) {
      if (SLICC_ONLY.has(name)) {
        throw new Error(`require('${id}'): sliccy:${name} is only available inside SLICC`);
      }
      const known = Object.keys(factories).sort().join(', ');
      throw new Error(
        `require('${id}'): unknown sliccy: module '${name}'. Known names: ${known}. ` +
          `Install @ai-ecoverse/sliccy-${name} to provide it.`
      );
    }
    cache.set(name, value);
    return value;
  };
}

const PNPM_GLOBAL_LINK = /^[0-9a-f]{64}$/;

/**
 * pnpm's global installs, in the kernel's order for their commands
 * (slicc-kernel's pnpmGlobalRoots: sorted, the first one wins). pnpm ≥ 11 puts each `pnpm add -g`
 * in a project of its own, `<PNPM_HOME>/global/v11/<id>/` (the 64-hex names
 * there are links to those), so a package added on its own is not next to
 * slicc-jsh; pnpm ≤ 10 had one `<PNPM_HOME>/global/<n>/`. PNPM_HOME, else
 * pnpm's default homes: the kernel's /usr/local/share/pnpm, Linux's
 * ~/.local/share/pnpm and macOS's ~/Library/pnpm.
 */
export function globalRoots(fs, env) {
  const homes = new Set(
    [
      env.PNPM_HOME,
      '/usr/local/share/pnpm',
      env.HOME && `${env.HOME}/.local/share/pnpm`,
      env.HOME && `${env.HOME}/Library/pnpm`,
    ].filter(Boolean)
  );
  const isDir = (path) => {
    try {
      return fs.lstatSync(path).isDirectory();
    } catch {
      return false;
    }
  };
  const list = (path) => {
    try {
      return fs.readdirSync(path).sort();
    } catch {
      return [];
    }
  };
  const roots = [];
  for (const home of homes) {
    for (const layout of list(`${home}/global`)) {
      const base = `${home}/global/${layout}`;
      if (isDir(`${base}/node_modules`)) roots.push(base);
      for (const id of list(base)) {
        if (id === 'node_modules' || PNPM_GLOBAL_LINK.test(id)) continue;
        if (isDir(`${base}/${id}`) && isDir(`${base}/${id}/node_modules`)) roots.push(`${base}/${id}`);
      }
    }
  }
  return roots;
}

function globalRequires(engine, process, require) {
  if (!engine.createRequire || !require) return [];
  let fs;
  try {
    fs = require('fs');
  } catch {
    return [];
  }
  return globalRoots(fs, process.env).map((root) => engine.createRequire(`${root}/package.json`));
}

function findPackage(name, lookups) {
  for (const pkg of [`@ai-ecoverse/sliccy-${name}`, `sliccy-${name}`]) {
    for (const req of lookups) {
      try {
        return req(pkg);
      } catch (err) {
        if (!isNotFound(err, pkg)) throw err;
      }
    }
  }
  return undefined;
}
