/**
 * Source maps, as Node 22.22.0's: lib/internal/source_map (vendored
 * unchanged in src/node-lib) caches a module's map when support is on
 * (`--enable-source-maps`, `process.setSourceMapsEnabled`,
 * `module.setSourceMapsSupport`) and then formats every stack through it
 * (stack.mjs's internal formatter), and names the original source line of
 * an uncaught error. This module is the runtime's side: the loaders hand it
 * each compiled module, the error report asks it for the mapped source.
 */
import { sourceMapHooks } from './node-bindings.mjs';

let enabled = false;
let lib;
let processRef;
// --enable-source-maps, applied once the builtins exist (the cache needs fs).
let pending;
const cache = () => {
  if (!lib) {
    lib = processRef._nodeLib().sourceMapCache;
    if (pending) {
      const options = pending;
      pending = undefined;
      lib.setSourceMapsSupport(true, options);
    }
  }
  return lib;
};

// lib/internal/source_map/source_map_cache's own magic-comment pattern.
const kSourceMappingURL = /\/[*/]#\s+sourceMappingURL=(?<sourceMappingURL>[^\s]+)/g;

/** Wires the process: support from `--enable-source-maps` (Node's pre-execution). */
export function initSourceMaps(process) {
  processRef = process;
  if (process.execArgv.includes('--enable-source-maps')) {
    enabled = true;
    pending = { __proto__: null, nodeModules: true, generatedCode: true };
  }
}

/** module.setSourceMapsSupport / process.setSourceMapsEnabled. */
export function setSourceMapsSupport(value, options) {
  const support = cache();
  support.setSourceMapsSupport(value, options);
  enabled = support.getSourceMapsSupport().enabled;
}

/** module.getSourceMapsSupport. */
export function getSourceMapsSupport() {
  if (enabled || lib) return cache().getSourceMapsSupport();
  return Object.freeze({ __proto__: null, enabled: false, nodeModules: false, generatedCode: false });
}

/** module.findSourceMap. */
export function findSourceMap(path) {
  return enabled || lib ? cache().findSourceMap(path) : undefined;
}

/** module.SourceMap. */
export function SourceMapClass() {
  return processRef._nodeLib().sourceMap.SourceMap;
}

/**
 * A module just compiled (`filename`: its path or file: URL, `content`: its
 * source, `moduleInstance`: what the cache entry lives as long as): its
 * `sourceMappingURL` cached, as Node's loaders do with V8's script.sourceMapURL.
 */
export function cacheModuleSourceMap(filename, content, moduleInstance) {
  if (!enabled || typeof content !== 'string' || !content.includes('sourceMappingURL')) return;
  let match;
  let last;
  kSourceMappingURL.lastIndex = 0;
  while ((match = kSourceMappingURL.exec(content))) last = match;
  if (!last) return;
  try {
    cache().maybeCacheSourceMap(filename, content, moduleInstance, false, undefined, last.groups.sourceMappingURL);
  } catch {
    /* a map that can't be read: the stack stays as it is, as Node's */
  }
}

/**
 * Node's GetErrorSource with source maps: the original `file:line`, source
 * line and caret of an uncaught error thrown at `fileName:line:column`
 * (column 0-based), or undefined.
 */
export function sourceMapErrorSource(fileName, line, column) {
  if (!enabled || typeof sourceMapHooks.errorSource !== 'function') return undefined;
  try {
    return sourceMapHooks.errorSource(fileName, line, column);
  } catch {
    return undefined;
  }
}
