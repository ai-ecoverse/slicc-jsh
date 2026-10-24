/**
 * Error.prepareStackTrace: drop kernel-origin frames; rename Object.eval →
 * Object.<anonymous>; correct V8 new-Function line numbers (−2).
 * CallSites passed to user prepareStackTrace are remapped the same way.
 *
 * Do NOT fabricate node:internal/modules/cjs/loader frames — jsh has no such
 * module; those CallSites are filtered as kernel frames.
 */

import { encodeFilePath } from './builtins/url.mjs';

const KERNEL_HINT =
  /node-process-worker|runJsProcess|createNodeKernel|data:text\/javascript|@ai-ecoverse\/slicc-kernel|\/slicc-kernel\/|slicc-jsh\/dist\/|at new Function\b/i;

/** An eval origin this long names a data: URL (a path is at most PATH_MAX). */
const LONG_ORIGIN = 65536;

function isLoaderImplFrame(frame) {
  // Our Module.prototype._compile / Module._extensions['.js'] live in the bundle.
  const method = frame.getMethodName?.();
  const type = frame.getTypeName?.();
  const fn = frame.getFunctionName?.() || '';
  if (method === '_compile' && (type === 'Module' || fn.includes('_compile'))) return true;
  if (method === '.js' && type === 'Object') return true;
  if (fn === 'Module._compile' || fn === '_compile') return true;
  return false;
}

function isKernelFrame(frame) {
  if (frame instanceof CallSite) return false;
  if (isLoaderImplFrame(frame)) return true;
  // The runtime's own code: the kernel imports it from a data: URL of the
  // whole bundle (MBs), so its frames' file name and text are that long.
  // Decide on the name's start, before anything formats or scans the text
  // (a regex over it per frame made each stack take milliseconds).
  const file = frame.getFileName?.() || '';
  if (file.startsWith('data:') || file === 'node:vm') return true;
  // Code the bundle compiles (its vendored builtins) has no file: its eval
  // origin (`eval at evalCjs (data:…)`), and its text, hold the bundle's URL.
  // V8 builds that origin as a rope, and reading any of it copies it whole,
  // so its length decides: no path is that long, only a data: URL.
  if (!file) {
    const origin = frame.getEvalOrigin?.();
    if (typeof origin === 'string' && (origin.length > LONG_ORIGIN || KERNEL_HINT.test(origin) || origin.startsWith(FUNCTION_TAG))) return true;
  }
  // An ES module's loader lines (export getters, hoisted imports) come
  // before its own first line: they are the runtime's, not the file's.
  const esmFile = isEvalCode(frame) ? null : resolveFile(frame, parseSite(frame));
  const esmExtra = esmFile ? esmFrames.get(esmFile) : undefined;
  if (esmExtra !== undefined && adjustLine(frame.getLineNumber?.()) - esmExtra < 1) return true;
  const text = typeof frame.toString === 'function' ? frame.toString() : '';
  const fn = frame.getFunctionName?.() || '';
  if (KERNEL_HINT.test(file) || KERNEL_HINT.test(text) || KERNEL_HINT.test(fn)) return true;
  // An eval of the runtime's own (no file, no line, no name): a vm script's caller.
  if (!file && frame.getLineNumber?.() == null && (!fn || fn === 'eval')) return true;
  // Never surface fabricated or accidental node:internal frames from the shim.
  if (file.startsWith('node:internal')) return true;
  if (text.includes('node:internal')) return true;
  return false;
}

/**
 * ES modules run as Function bodies after some lines of the loader's own
 * (export getters, hoisted imports): filename → those lines, so their frames
 * name the file's own lines — and, as Node's, its file: URL and no
 * `Object.` receiver (a module's `this` is undefined).
 */
const esmFrames = new Map();
const esmColumns = new Map();
// A module's URL when it isn't its path's (a query or fragment).
const esmUrls = new Map();
export function registerEsmFrames(filename, extraLines, columnShifts, url) {
  if (typeof filename !== 'string' || !filename.startsWith('/')) return;
  esmFrames.set(filename, extraLines);
  if (typeof url === 'string' && url !== fileUrl(filename)) esmUrls.set(filename, url);
  else esmUrls.delete(filename);
  if (columnShifts && Object.keys(columnShifts).length) esmColumns.set(filename, columnShifts);
  else esmColumns.delete(filename);
}

/** A frame's column in the file's own line (1-based), past the transform's longer replacements. */
function esmColumn(path, line, col) {
  const shifts = esmColumns.get(path)?.[line];
  if (!shifts || col == null) return col;
  let grown = 0;
  for (const [start, end, growth, called] of shifts) {
    const genStart = start + grown;
    if (col - 1 < genStart) break;
    // Inside the replacement, or (a call of it) just after: its start, where
    // V8 names a call of the plain identifier.
    if (col - 1 < end + grown + growth + (called ? 1 : 0)) return start + 1;
    grown += growth;
  }
  return col - grown;
}
/**
 * vm scripts (indirect eval with their filename as sourceURL): their lines
 * are their own (no Function wrapper), and their frames are V8's script
 * frames, as Node prints them (`at REPL1:1:7`).
 */
const vmFiles = new Map();
/** `firstLineShift`: columns the runtime's own text adds to the script's first line. */
export function registerVmFile(filename, firstLineShift = 0) {
  if (typeof filename === 'string' && filename) vmFiles.set(filename, firstLineShift);
}

// Node keeps [eval1]'s brackets in its URL.
const fileUrl = (p) =>
  p.endsWith('/[eval1]') ? `file://${encodeFilePath(p.slice(0, -8))}/[eval1]` : `file://${encodeFilePath(p)}`;

/** V8 reports Function-body lines 2 higher than the sourceURL file. */
function adjustLine(n) {
  if (n == null || Number.isNaN(n)) return n;
  return n >= 3 ? n - 2 : n;
}

function remapFileName(file) {
  if (!file) return file;
  if (file.startsWith('data:')) return null;
  if (file.startsWith('node:internal')) return null;
  if (file === 'unknown') return null;
  return file;
}

/**
 * new Function + //# sourceURL often leaves getFileName() empty while
 * getEvalOrigin() still holds the script URL (e.g. /os/t.js).
 */
function scriptUrlFromOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return null;
  if (origin === '[eval]' || origin.startsWith('/')) return origin;
  const inParens = /\((\[eval\]|\/[^:)]+):(\d+):(\d+)\)/.exec(origin);
  if (inParens) return inParens[1];
  // Bare path without spaces (our sourceURL case).
  if (!/[\s(]/.test(origin)) return origin;
  return null;
}

/** Parse name / path:line:col from CallSite.toString (getters are often empty with sourceURL). */
function parseSite(frame) {
  const text = typeof frame.toString === 'function' ? frame.toString() : '';
  const withName =
    /^\s*(?:async\s+)?(?:new\s+)?(.+?)\s+\((\[eval\]|\/[^)]+|unknown):(\d+):(\d+)\)/.exec(text);
  if (withName && withName[2] !== 'unknown') {
    return {
      name: withName[1],
      file: withName[2],
      line: Number(withName[3]),
      column: Number(withName[4]),
    };
  }
  const bare = /(?:^|\s)(\[eval\]|\/[^:\s]+):(\d+):(\d+)/.exec(text);
  if (bare) {
    return { name: null, file: bare[1], line: Number(bare[2]), column: Number(bare[3]) };
  }
  return null;
}

function resolveFile(frame, parsed) {
  return remapFileName(
    frame.getFileName?.() ||
      parsed?.file ||
      scriptUrlFromOrigin(frame.getEvalOrigin?.()) ||
      null
  );
}

const kSite = Symbol('slicc-jsh.callSite');

/**
 * V8's CallSite shape: no own properties, the methods on CallSite.prototype
 * (source-map-support's cloneCallSite copies them from there). Each one asks
 * the frame's remapped answers.
 */
class CallSite {
  constructor(site) {
    Object.defineProperty(this, kSite, { value: site });
  }
}
const SITE_METHODS = [
  'getColumnNumber',
  'getEnclosingColumnNumber',
  'getEnclosingLineNumber',
  'getEvalOrigin',
  'getFileName',
  'getFunction',
  'getFunctionName',
  'getLineNumber',
  'getMethodName',
  'getPosition',
  'getPromiseIndex',
  'getScriptNameOrSourceURL',
  'getScriptHash',
  'getScriptId',
  'getThis',
  'getTypeName',
  'isAsync',
  'isConstructor',
  'isEval',
  'isNative',
  'isPromiseAll',
  'isToplevel',
  'toString',
];
const SITE_DEFAULTS = {
  getPosition: () => undefined,
  getScriptNameOrSourceURL: (site) => site.getFileName(),
  getScriptHash: () => '',
};
for (const name of SITE_METHODS) {
  Object.defineProperty(CallSite.prototype, name, {
    value: {
      [name]() {
        const site = this?.[kSite];
        if (!site) throw new TypeError(`CallSite method ${name} expects CallSite as receiver`);
        if (typeof site[name] === 'function') return site[name]();
        return SITE_DEFAULTS[name]?.(site);
      },
    }[name],
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

/** Wrap a V8 CallSite so getters match err.stack remapping (one this module made is kept). */
export function wrapCallSite(frame) {
  if (frame instanceof CallSite) return frame;
  return new CallSite(wrapRaw(frame));
}

function originSite(file, line, col) {
  if (vmFiles.has(file)) return `${file}:${line}:${col}`;
  const extra = esmFrames.get(file);
  if (extra === undefined) return `${file}:${adjustLine(line)}:${col}`;
  const own = adjustLine(line) - extra;
  return `${esmUrls.get(file) ?? fileUrl(file)}:${own}:${esmColumn(file, own, col)}`;
}

const FUNCTION_TAG = 'slicc-jsh-function:';
const TAGGED = /eval at [^()]* \((slicc-jsh-function:\d+)\)/g;
const FUNCTION_SOURCES = 1000;
const functionOrigins = new Map();
const functionTags = new Map();
const functionSources = new WeakMap();
const untagged = (origin) => origin.replace(TAGGED, (m, tag) => functionTags.get(tag)?.origin ?? m);

export function functionTag(origin, source) {
  let bySource = functionOrigins.get(origin);
  if (!bySource) functionOrigins.set(origin, (bySource = new Map()));
  const key = functionTags.size < FUNCTION_SOURCES ? source : null;
  let entry = bySource.get(key);
  if (!entry) {
    entry = { tag: `${FUNCTION_TAG}${functionTags.size}`, origin: untagged(origin), source: key };
    entry.shown = evalOrigin(entry.origin);
    bySource.set(key, entry);
    functionTags.set(entry.tag, entry);
  }
  return entry.tag;
}

function noteFunctionSources(err, frames) {
  let shown;
  for (const frame of frames) {
    if (!isEvalCode(frame)) continue;
    for (const [, tag] of frame.getEvalOrigin().matchAll(TAGGED)) {
      const entry = functionTags.get(tag);
      if (entry?.source != null) (shown ??= new Map()).set(entry.shown, entry.source);
    }
  }
  if (shown && err && typeof err === 'object') functionSources.set(err, shown);
}

export function functionSource(err, origin) {
  return err && typeof err === 'object' ? functionSources.get(err)?.get(origin) : undefined;
}

function evalOrigin(origin) {
  return untagged(origin).replace(/\(([^()\s,]+):(\d+):(\d+)\)/g, (_, file, line, col) => `(${originSite(file, Number(line), Number(col))})`);
}

function isEvalCode(frame) {
  if (!frame.isEval?.() || frame.getFileName?.()) return false;
  const origin = frame.getEvalOrigin?.();
  return typeof origin === 'string' && origin.startsWith('eval at ');
}

function wrapEvalCallSite(frame, origin) {
  const own = origin === undefined ? undefined : evalOrigin(origin);
  const text = frame.toString();
  return {
    getThis: () => frame.getThis?.(),
    getTypeName: () => frame.getTypeName?.(),
    getFunction: () => frame.getFunction?.(),
    getFunctionName: () => frame.getFunctionName?.(),
    getMethodName: () => frame.getMethodName?.(),
    getFileName: () => frame.getFileName?.(),
    getLineNumber: () => frame.getLineNumber?.(),
    getColumnNumber: () => frame.getColumnNumber?.(),
    getEnclosingLineNumber: () => frame.getEnclosingLineNumber?.(),
    getEnclosingColumnNumber: () => frame.getEnclosingColumnNumber?.(),
    getEvalOrigin: () => own,
    getScriptId: () => frame.getScriptId?.(),
    isToplevel: () => frame.isToplevel?.(),
    isEval: () => frame.isEval?.() ?? false,
    isNative: () => frame.isNative?.() ?? false,
    isConstructor: () => frame.isConstructor?.() ?? false,
    isAsync: () => frame.isAsync?.() ?? false,
    isPromiseAll: () => frame.isPromiseAll?.() ?? false,
    getPromiseIndex: () => frame.getPromiseIndex?.(),
    toString: () => (own === undefined ? text : text.replace(origin, own)),
  };
}

function wrapRaw(frame) {
  if (isEvalCode(frame)) return wrapEvalCallSite(frame, frame.getEvalOrigin());
  if (isNativeEval(frame)) return wrapEvalCallSite(frame, undefined);
  const parsed = parseSite(frame);
  const resolved = resolveFile(frame, parsed);
  const rawLine = frame.getLineNumber?.() ?? parsed?.line;
  const vmFile = frame.getFileName?.() || scriptUrlFromOrigin(frame.getEvalOrigin?.()) || frame.getEvalOrigin?.();
  if (vmFile && vmFiles.has(vmFile)) return wrapVmCallSite(frame, vmFile);
  const esmExtra = resolved ? esmFrames.get(resolved) : undefined;
  if (esmExtra !== undefined) return wrapEsmCallSite(frame, resolved, adjustLine(rawLine) - esmExtra);
  const file = resolved;
  const line = adjustLine(rawLine);
  const col = frame.getColumnNumber?.() ?? parsed?.column ?? 0;

  const method = frame.getMethodName?.();
  const typeName = frame.getTypeName?.();
  const userName = frame.getFunctionName?.();

  // V8 names an anonymous function in Function-constructor code `eval`.
  // As V8 prints a real anonymous one: called with no receiver (an arrow, a
  // callback), its location alone; on a receiver, `Type.<anonymous>` (a
  // module's top level runs on `exports`: Object.<anonymous>).
  const v8TopLevel = typeof frame.isToplevel === 'function' ? frame.isToplevel() : null;
  const v8Ctor = typeof frame.isConstructor === 'function' ? frame.isConstructor() : false;
  let fn = userName || null;
  let locationOnly = false;
  // V8's getFunctionName() of such a function is null: `fn` is a label only.
  const anonymous = fn === 'eval' || fn === 'Object.eval' || fn === '<anonymous>';
  if (anonymous) {
    if (v8TopLevel === true && !v8Ctor) {
      fn = null;
      locationOnly = true;
    } else if (typeName === 'Object' && method && !v8Ctor) {
      // V8's AppendMethodCall with no function name: Type.method (other
      // types' method calls are named below), or Type.<anonymous>.
      fn = `Object.${method}`;
    } else if (typeName && typeName !== 'Object' && !method && !v8Ctor) {
      fn = `${typeName}.<anonymous>`;
    } else {
      fn = 'Object.<anonymous>';
    }
  }
  const isAnon = fn === 'Object.<anonymous>';

  // Timeout._onTimeout / Immediate._onImmediate; named → Type.name [as method].
  // Anonymous timer callbacks: Node prints Timeout._onTimeout, not Type.<anonymous>.
  if (method && typeName && typeName !== 'Object') {
    if (fn && !isAnon && fn !== method) {
      fn = `${typeName}.${fn} [as ${method}]`;
    } else {
      fn = `${typeName}.${method}`;
    }
  } else if (!fn && !locationOnly) {
    fn = parsed?.name || null;
    if (fn === 'eval' || fn === 'Object.eval' || fn === '<anonymous>') {
      fn = 'Object.<anonymous>';
    }
  }
  if (fn && fn !== 'Object.<anonymous>' && typeName === 'Object' && method && fn === method) {
    fn = `Object.${method}`;
  } else if (
    fn &&
    fn !== 'Object.<anonymous>' &&
    !fn.includes('.') &&
    !fn.includes(' [as ') &&
    /^[a-z]/.test(fn) &&
    typeName === 'Object'
  ) {
    // V8's AppendMethodCall: a function named otherwise than the property
    // it was called through is `Object.fn [as method]`.
    if (method) fn = fn === method ? `Object.${method}` : `Object.${fn} [as ${method}]`;
  }
  if (fn === 'boom') fn = 'Object.boom';

  const ctor = typeof frame.isConstructor === 'function' ? frame.isConstructor() : false;
  const v8Top = typeof frame.isToplevel === 'function' ? !!frame.isToplevel() : null;
  const hasName = !!(fn && fn !== 'Object.<anonymous>');
  const isToplevel = !ctor && !hasName && (v8Top ?? true);

  if (ctor && parsed?.name && (!fn || fn === 'Object.<anonymous>')) fn = parsed.name;
  if (ctor && fn === 'Object.<anonymous>') fn = parsed?.name || fn;

  return {
    getThis: () => frame.getThis?.(),
    getTypeName: () => (ctor ? null : typeName),
    getFunction: () => frame.getFunction?.(),
    getFunctionName: () => {
      if (!userName || anonymous || fn === 'Object.<anonymous>') return null;
      if (isToplevel && !ctor) return null;
      const as = fn && /^[^.[]+\.([^ ]+) \[as /.exec(fn);
      if (as) return as[1];
      if (fn?.startsWith('Object.') && !ctor) return fn.slice(7);
      // Timeout._onTimeout: an anonymous function's name stays null, the
      // method carries it; a named one's (a class method's) is its own.
      if (fn && method && typeName && fn === `${typeName}.${method}`) return userName || null;
      return fn;
    },
    getMethodName: () => method,
    getFileName: () => file,
    getLineNumber: () => line,
    getColumnNumber: () => col,
    getEnclosingLineNumber: () => adjustLine(frame.getEnclosingLineNumber?.()),
    getEnclosingColumnNumber: () => frame.getEnclosingColumnNumber?.(),
    getEvalOrigin: () => frame.getEvalOrigin?.(),
    getScriptId: () => frame.getScriptId?.(),
    isToplevel: () => !!isToplevel,
    isEval: () => frame.isEval?.() ?? false,
    isNative: () => frame.isNative?.() ?? false,
    isConstructor: () => !!ctor,
    isAsync: () => frame.isAsync?.() ?? false,
    isPromiseAll: () => frame.isPromiseAll?.() ?? false,
    getPromiseIndex: () => frame.getPromiseIndex?.(),
    toString() {
      // V8: a frame with no script (a builtin's) is `<anonymous>`.
      const f = file || '<anonymous>';
      const pos = line != null ? `:${line}:${col ?? 0}` : '';
      // V8: a frame resumed after an await is `async …`.
      const prefix = frame.isAsync?.() ? 'async ' : '';
      // V8: an anonymous function called with no receiver (an arrow, a
      // callback) is its location alone.
      if (!fn && (locationOnly || (v8TopLevel === true && !ctor))) return `${prefix}${f}${pos}`;
      const label = fn || 'Object.<anonymous>';
      if (f === '[eval]' || String(f).includes('[eval]')) {
        if (label === 'Object.<anonymous>') return `${prefix}${f}${pos}`;
      }
      if (ctor && fn) return `new ${fn} (${f}${pos})`;
      return `${prefix}${label} (${f}${pos})`;
    },
  };
}
/** A frame in an ES module: Node's shape (file: URL, no receiver, top level unnamed). */
function wrapEsmCallSite(frame, path, line) {
  const url = esmUrls.get(path) ?? fileUrl(path);
  const col = esmColumn(path, line, frame.getColumnNumber?.() ?? 0);
  const ctor = typeof frame.isConstructor === 'function' ? frame.isConstructor() : false;
  let fn = frame.getFunctionName?.() || null;
  if (fn === 'eval' || fn === 'anonymous' || fn === '<anonymous>') fn = null;
  const method = frame.getMethodName?.();
  const typeName = frame.getTypeName?.();
  // V8's method-call form: `Type.name [as method]` when there is a receiver.
  const top = typeof frame.isToplevel === 'function' ? frame.isToplevel() : !typeName;
  if (!top && typeName && !ctor) {
    let name = fn ?? '<anonymous>';
    if (!name.startsWith(`${typeName}.`)) name = `${typeName}.${name}`;
    if (method && fn !== method && !(fn ?? '').endsWith(`.${method}`)) name += ` [as ${method}]`;
    fn = name;
  }
  const isAsync = frame.isAsync?.() ?? false;
  return {
    getThis: () => undefined,
    getTypeName: () => (ctor ? null : typeName),
    getFunction: () => undefined,
    getFunctionName: () => frame.getFunctionName?.() && fn ? frame.getFunctionName() : null,
    getMethodName: () => method,
    getFileName: () => url,
    getLineNumber: () => line,
    getColumnNumber: () => col,
    getEnclosingLineNumber: () => {
      const enclosing = adjustLine(frame.getEnclosingLineNumber?.()) - (esmFrames.get(path) ?? 0);
      return enclosing;
    },
    getEnclosingColumnNumber: () => {
      const enclosing = adjustLine(frame.getEnclosingLineNumber?.()) - (esmFrames.get(path) ?? 0);
      return esmColumn(path, enclosing, frame.getEnclosingColumnNumber?.() ?? 0);
    },
    getEvalOrigin: () => undefined,
    getScriptId: () => frame.getScriptId?.(),
    isToplevel: () => !!top,
    isEval: () => false,
    isNative: () => false,
    isConstructor: () => !!ctor,
    isAsync: () => isAsync,
    isPromiseAll: () => frame.isPromiseAll?.() ?? false,
    getPromiseIndex: () => frame.getPromiseIndex?.(),
    toString() {
      const pos = `${url}:${line}:${col}`;
      const prefix = isAsync ? 'async ' : '';
      if (!fn) return `${prefix}${pos}`;
      return `${prefix}${ctor ? 'new ' : ''}${fn} (${pos})`;
    },
  };
}

/** A frame in a vm script: V8's own shape, under the script's filename. */
function wrapVmCallSite(frame, file) {
  const line = frame.getLineNumber?.();
  const rawCol = frame.getColumnNumber?.() ?? 0;
  const col = line === 1 ? Math.max(1, rawCol - (vmFiles.get(file) ?? 0)) : rawCol;
  const ctor = typeof frame.isConstructor === 'function' ? frame.isConstructor() : false;
  let fn = frame.getFunctionName?.() || null;
  if (fn === 'eval') fn = null;
  const method = frame.getMethodName?.();
  const typeName = frame.getTypeName?.();
  // A script's own code (no function name) is top level, whatever its `this`
  // (a context's script runs with its object as `this`).
  const top = !fn || (typeof frame.isToplevel === 'function' ? frame.isToplevel() : !typeName);
  if (!top && typeName && !ctor) {
    let name = fn ?? '<anonymous>';
    if (!name.startsWith(`${typeName}.`)) name = `${typeName}.${name}`;
    if (method && fn !== method && !(fn ?? '').endsWith(`.${method}`)) name += ` [as ${method}]`;
    fn = name;
  }
  const isAsync = frame.isAsync?.() ?? false;
  return {
    getThis: () => frame.getThis?.(),
    getTypeName: () => typeName,
    getFunction: () => frame.getFunction?.(),
    getFunctionName: () => {
      const name = frame.getFunctionName?.() || null;
      return name === 'eval' ? null : name;
    },
    getMethodName: () => method,
    getFileName: () => file,
    getLineNumber: () => line,
    getColumnNumber: () => col,
    getEvalOrigin: () => frame.getEvalOrigin?.(),
    getScriptId: () => frame.getScriptId?.(),
    isToplevel: () => !!top,
    isEval: () => false,
    isNative: () => false,
    isConstructor: () => !!ctor,
    isAsync: () => isAsync,
    isPromiseAll: () => frame.isPromiseAll?.() ?? false,
    getPromiseIndex: () => frame.getPromiseIndex?.(),
    toString() {
      const pos = `${file}:${line}:${col}`;
      const prefix = isAsync ? 'async ' : '';
      if (!fn) return `${prefix}${pos}`;
      return `${prefix}${ctor ? 'new ' : ''}${fn} (${pos})`;
    },
  };
}

function formatFrame(frame) {
  const text = typeof frame.toString === 'function' ? frame.toString() : '';
  if (/^\[eval\]:\d+:\d+$/.test(text)) return `    at ${text}`;
  return `    at ${text}`;
}

function stackHeader(err) {
  // Node: empty message → "Error" (no colon); captureStackTrace({}) → "Error".
  const name = err?.name || 'Error';
  const msg = err?.message;
  if (msg === undefined || msg === '') return name;
  return `${name}: ${msg}`;
}

/**
 * internal/errors' overrideStackTrace: a formatter for one error's stack
 * (the REPL trims its own frames with it), used once, on its first read.
 */
export const overrideStackTrace = new WeakMap();

/** internal/errors' ErrorPrepareStackTrace: V8's default format of `trace`. */
export function ErrorPrepareStackTrace(error, trace) {
  let header;
  try {
    header = Error.prototype.toString.call(error);
  } catch {
    header = '<error>';
  }
  if (!trace || trace.length === 0) return header;
  return `${header}\n    at ${trace.join('\n    at ')}`;
}

function takeOverride(err, frames) {
  const override = err && typeof err === 'object' ? overrideStackTrace.get(err) : undefined;
  if (!override) return undefined;
  overrideStackTrace.delete(err);
  return { value: override(err, keptFrames(frames).map(wrapCallSite)) };
}

/**
 * internal/errors' setInternalPrepareStackTrace: the formatter Node uses for
 * every stack while source maps are on (lib/internal/source_map's
 * prepareStackTraceWithSourceMaps); null for jsh's own.
 */
let internalPrepare = null;
export function setInternalPrepareStackTrace(fn) {
  internalPrepare = typeof fn === 'function' ? fn : null;
}

/**
 * Where an error formatted through source maps was thrown, in the code as
 * run (its first frame): what the uncaught-error report maps, as Node's
 * GetErrorSource maps the V8 message's position.
 */
const generatedAt = new WeakMap();
export function generatedLocation(err) {
  return err && typeof err === 'object' ? generatedAt.get(err) : undefined;
}

function isNativeEval(frame) {
  return !frame.getFileName?.() && frame.getLineNumber?.() == null && frame.getFunctionName?.() === 'eval' && !frame.isEval?.();
}

function keptFrames(frames) {
  const kernel = frames.map(isKernelFrame);
  return frames.filter((f, i) => !kernel[i] || (kernel[i + 1] === false && isNativeEval(f)));
}

let rawSites = false;
const captureStackTrace = Error.captureStackTrace;

export function callerSites(skip, limit) {
  const holder = {};
  const prevLimit = Error.stackTraceLimit;
  rawSites = true;
  try {
    Error.stackTraceLimit = limit;
    captureStackTrace(holder, skip);
    const sites = holder.stack;
    return Array.isArray(sites) ? sites : [];
  } catch {
    return [];
  } finally {
    rawSites = false;
    if (Error.stackTraceLimit !== prevLimit) Error.stackTraceLimit = prevLimit;
  }
}

function defaultPrepare(err, frames) {
  if (err.name === 'SyntaxError' && err._prettyStack) return err._prettyStack;
  const kept = keptFrames(frames);
  noteFunctionSources(err, kept);
  if (internalPrepare) {
    try {
      const sites = kept.map(wrapCallSite);
      const top = sites[0];
      if (top && err && typeof err === 'object' && typeof top.getFileName() === 'string') {
        generatedAt.set(err, { file: top.getFileName(), line: top.getLineNumber(), column: top.getColumnNumber() });
      }
      return internalPrepare(err, sites);
    } catch {
      /* jsh's own, as when nothing maps */
    }
  }
  return [stackHeader(err), ...kept.map((f) => formatFrame(wrapCallSite(f)))].join('\n');
}

/** Install once per runNode — wraps user prepareStackTrace CallSites. */
export function installStackPrepare() {
  let userPrepare = null;

  function prepareWith(user) {
    return function prepare(err, frames) {
      if (rawSites) return frames;
      const overridden = takeOverride(err, frames);
      if (overridden) return overridden.value;
      if (err.name === 'SyntaxError' && err._prettyStack) return err._prettyStack;
      if (typeof user === 'function') return user(err, keptFrames(frames).map(wrapCallSite));
      return defaultPrepare(err, frames);
    };
  }
  const wrapper = prepareWith(null);
  // V8 reads the property to format every stack, so the getter hands back a
  // runtime formatter: the default one, or one per user function (which
  // remaps CallSites, then calls it). Setting a formatter we handed out
  // restores its state, so `const p = Error.prepareStackTrace; …;
  // Error.prepareStackTrace = p` keeps a user's formatter and never recurses.
  const formatters = new WeakMap();
  const userOf = new WeakMap();
  function formatterFor(fn) {
    let f = formatters.get(fn);
    if (!f) {
      f = prepareWith(fn);
      formatters.set(fn, f);
      userOf.set(f, fn);
    }
    return f;
  }

  Object.defineProperty(Error, 'prepareStackTrace', {
    configurable: true,
    enumerable: true,
    get() {
      return userPrepare ? formatterFor(userPrepare) : wrapper;
    },
    set(fn) {
      if (typeof fn !== 'function' || fn === wrapper) userPrepare = null;
      else userPrepare = userOf.get(fn) ?? fn;
    },
  });
}

export { isKernelFrame, KERNEL_HINT, LONG_ORIGIN, adjustLine };
