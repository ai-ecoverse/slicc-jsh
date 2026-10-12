/**
 * `sliccy:<name>` resolution, the same in both engines:
 *
 * 1. names built into slicc-jsh (`cli`, `color`, `exec`, `fmt`, `http`,
 *    `pool`, `skill`, `time`);
 * 2. `@ai-ecoverse/sliccy-<name>`, then `sliccy-<name>`, found with Node's
 *    algorithm from the script's directory, then from slicc-jsh's own
 *    location (so a global install next to a global `jsh` is found);
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
  const lookups = [require, engine.selfRequire].filter(Boolean);

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
