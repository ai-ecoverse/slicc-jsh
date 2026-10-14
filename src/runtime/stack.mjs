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
  if (frame?.[kWrapped]) return false;
  if (isLoaderImplFrame(frame)) return true;
  // An ES module's loader lines (export getters, hoisted imports) come
  // before its own first line: they are the runtime's, not the file's.
  const esmFile = resolveFile(frame, parseSite(frame));
  const esmExtra = esmFile ? esmFrames.get(esmFile) : undefined;
  if (esmExtra !== undefined && adjustLine(frame.getLineNumber?.()) - esmExtra < 1) return true;
  const file = frame.getFileName?.() || '';
  const text = typeof frame.toString === 'function' ? frame.toString() : '';
  const fn = frame.getFunctionName?.() || '';
  if (KERNEL_HINT.test(file) || KERNEL_HINT.test(text) || KERNEL_HINT.test(fn)) return true;
  if (file.startsWith('data:')) return true;
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

/** Marks a CallSite this module made (wrapping it again would remap it twice). */
const kWrapped = Symbol('slicc-jsh.wrappedCallSite');

/** Wrap a V8 CallSite so getters match err.stack remapping. */
export function wrapCallSite(frame) {
  if (frame?.[kWrapped]) return frame;
  return Object.assign(wrapRaw(frame), { [kWrapped]: true });
}

function wrapRaw(frame) {
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
    if (method) fn = `Object.${method}`;
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
      if (anonymous || fn === 'Object.<anonymous>') return null;
      if (isToplevel && !ctor) return null;
      if (fn?.startsWith('Object.') && !ctor) return fn.slice(7);
      const as = fn && /^[^.[]+\.([^ ]+) \[as /.exec(fn);
      if (as) return as[1];
      // Timeout._onTimeout: CallSite function name stays null; method carries it.
      if (fn && method && typeName && fn === `${typeName}.${method}`) return null;
      return fn;
    },
    getMethodName: () => method,
    getFileName: () => file,
    getLineNumber: () => line,
    getColumnNumber: () => col,
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
  return { value: override(err, frames.filter((f) => !isKernelFrame(f)).map(wrapCallSite)) };
}

function defaultPrepare(err, frames) {
  if (err.name === 'SyntaxError' && err._prettyStack) return err._prettyStack;
  const kept = frames.filter((f) => !isKernelFrame(f));
  return [stackHeader(err), ...kept.map((f) => formatFrame(wrapCallSite(f)))].join('\n');
}

/** Install once per runNode — wraps user prepareStackTrace CallSites. */
export function installStackPrepare() {
  let userPrepare = null;

  function prepareWith(user) {
    return function prepare(err, frames) {
      const overridden = takeOverride(err, frames);
      if (overridden) return overridden.value;
      if (err.name === 'SyntaxError' && err._prettyStack) return err._prettyStack;
      if (typeof user === 'function') return user(err, frames.filter((f) => !isKernelFrame(f)).map(wrapCallSite));
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

export { isKernelFrame, KERNEL_HINT, adjustLine };
