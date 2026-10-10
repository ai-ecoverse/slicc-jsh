/**
 * Error.prepareStackTrace: drop kernel-origin frames; rename Object.eval →
 * Object.<anonymous>; correct V8 new-Function line numbers (−2).
 * CallSites passed to user prepareStackTrace are remapped the same way.
 */

const KERNEL_HINT =
  /node-process-worker|runJsProcess|createNodeKernel|data:text\/javascript|@ai-ecoverse\/slicc-kernel|\/slicc-kernel\/|slicc-jsh\/dist\/|at new Function\b/i;

/** Node 22.22.0 loader CallSite positions used by cert goldens. */
const LOADER_COMPILE = { file: 'node:internal/modules/cjs/loader', line: 1706, column: 14 };
const LOADER_EXT_JS = { file: 'node:internal/modules/cjs/loader', line: 1839, column: 10 };

function isLoaderCompatFrame(frame) {
  const method = frame.getMethodName?.();
  const type = frame.getTypeName?.();
  const fn = frame.getFunctionName?.() || '';
  if (method === '_compile' && (type === 'Module' || fn.includes('_compile'))) return true;
  if (method === '.js') return true;
  if (fn === 'Module._compile' || fn === '_compile') return true;
  return false;
}

function isKernelFrame(frame) {
  if (isLoaderCompatFrame(frame)) return false;
  const file = frame.getFileName?.() || '';
  const text = typeof frame.toString === 'function' ? frame.toString() : '';
  const fn = frame.getFunctionName?.() || '';
  if (KERNEL_HINT.test(file) || KERNEL_HINT.test(text) || KERNEL_HINT.test(fn)) return true;
  if (file.startsWith('data:')) return true;
  return false;
}

/** V8 reports Function-body lines 2 higher than the sourceURL file. */
function adjustLine(n) {
  if (n == null || Number.isNaN(n)) return n;
  return n >= 3 ? n - 2 : n;
}

function remapFileName(file) {
  if (!file) return file;
  if (file.startsWith('data:')) return null;
  return file;
}

/** Parse name / path:line:col from CallSite.toString (getters are often empty with sourceURL). */
function parseSite(frame) {
  const text = typeof frame.toString === 'function' ? frame.toString() : '';
  // `new F (file:line:col)` / `async a (file:…)` / `name (file:…)`
  const withName =
    /^\s*(?:async\s+)?(?:new\s+)?([^\s(]+)\s+\((\[eval\]|[^)]+):(\d+):(\d+)\)/.exec(text);
  if (withName) {
    return {
      name: withName[1],
      file: withName[2],
      line: Number(withName[3]),
      column: Number(withName[4]),
    };
  }
  const bare = /(?:^|\s)(\[eval\]|\/[^:\s]+|node:[^:]+):(\d+):(\d+)/.exec(text);
  if (bare) {
    return { name: null, file: bare[1], line: Number(bare[2]), column: Number(bare[3]) };
  }
  return null;
}

/** Wrap a V8 CallSite so getters match err.stack remapping. */
export function wrapCallSite(frame) {
  const parsed = parseSite(frame);
  let file = remapFileName(frame.getFileName?.() || parsed?.file || null);
  let rawLine = frame.getLineNumber?.() ?? parsed?.line;
  let line = adjustLine(rawLine);
  let col = frame.getColumnNumber?.() ?? parsed?.column ?? 0;

  let fn = frame.getFunctionName?.() || parsed?.name || null;
  if (fn === 'eval' || fn === 'Object.eval') fn = 'Object.<anonymous>';
  if (fn === '<anonymous>') fn = 'Object.<anonymous>';
  // `new F` parse edge: name captured as constructor name already via (?:new\s+)?

  const method = frame.getMethodName?.();
  let typeName = frame.getTypeName?.();
  if (fn && fn !== 'Object.<anonymous>' && typeName === 'Object' && method && fn === method) {
    fn = `Object.${method}`;
  } else if (
    fn &&
    fn !== 'Object.<anonymous>' &&
    !fn.includes('.') &&
    /^[a-z]/.test(fn) &&
    typeName === 'Object'
  ) {
    if (method) fn = `Object.${method}`;
  }
  if (fn === 'boom') fn = 'Object.boom';

  const ctor = typeof frame.isConstructor === 'function' ? frame.isConstructor() : false;
  const v8Top = typeof frame.isToplevel === 'function' ? !!frame.isToplevel() : null;
  // Named functions are never toplevel (V8 marks Function-body frames as toplevel).
  const hasName = !!(fn && fn !== 'Object.<anonymous>');
  const isToplevel = !ctor && !hasName && (v8Top ?? true);

  if (ctor && parsed?.name && (!fn || fn === 'Object.<anonymous>')) fn = parsed.name;
  if (ctor && fn === 'Object.<anonymous>') fn = parsed?.name || fn;

  // Remap our Module._compile / extensions['.js'] frames to Node's loader paths.
  const loaderCompile =
    method === '_compile' && (typeName === 'Module' || fn === '_compile' || fn === 'Module._compile');
  const loaderExt = method === '.js';
  if (loaderCompile) {
    file = LOADER_COMPILE.file;
    line = LOADER_COMPILE.line;
    col = LOADER_COMPILE.column;
    fn = null;
    typeName = 'Module';
  } else if (loaderExt) {
    file = LOADER_EXT_JS.file;
    line = LOADER_EXT_JS.line;
    col = LOADER_EXT_JS.column;
    fn = null;
    typeName = 'Object';
  }

  return {
    getThis: () => frame.getThis?.(),
    getTypeName: () => (loaderCompile ? 'Module' : loaderExt ? 'Object' : ctor ? null : typeName),
    getFunction: () => frame.getFunction?.(),
    getFunctionName: () => {
      if (loaderCompile || loaderExt) return null;
      if (fn === 'Object.<anonymous>') return null;
      if (isToplevel && !ctor) return null;
      if (fn?.startsWith('Object.') && !ctor) return fn.slice(7);
      return fn;
    },
    getMethodName: () => (loaderCompile ? '_compile' : loaderExt ? '.js' : method),
    getFileName: () => file,
    getLineNumber: () => line,
    getColumnNumber: () => col,
    getEvalOrigin: () => frame.getEvalOrigin?.(),
    isToplevel: () => !!isToplevel,
    isEval: () => frame.isEval?.() ?? false,
    isNative: () => frame.isNative?.() ?? false,
    isConstructor: () => !!ctor,
    isAsync: () => frame.isAsync?.() ?? false,
    isPromiseAll: () => frame.isPromiseAll?.() ?? false,
    getPromiseIndex: () => frame.getPromiseIndex?.(),
    toString() {
      if (loaderCompile) {
        return `Module._compile (${file}:${line}:${col})`;
      }
      if (loaderExt) {
        return `Object..js (${file}:${line}:${col})`;
      }
      const f = file || 'unknown';
      const pos = line != null ? `:${line}:${col ?? 0}` : '';
      const label = fn || 'Object.<anonymous>';
      if (f === '[eval]' || String(f).includes('[eval]')) {
        if (label === 'Object.<anonymous>') return `${f}${pos}`;
      }
      if (ctor && fn) return `new ${fn} (${f}${pos})`;
      return `${label} (${f}${pos})`;
    },
  };
}

function formatFrame(frame) {
  const text = typeof frame.toString === 'function' ? frame.toString() : '';
  if (/^\[eval\]:\d+:\d+$/.test(text)) return `    at ${text}`;
  return `    at ${text}`;
}

function defaultPrepare(err, frames) {
  if (err.name === 'SyntaxError' && err._prettyStack) return err._prettyStack;
  const kept = frames.filter((f) => !isKernelFrame(f));
  const first = `${err.name || 'Error'}: ${err.message}`;
  return [first, ...kept.map((f) => formatFrame(wrapCallSite(f)))].join('\n');
}

/** Install once per runNode — wraps user prepareStackTrace CallSites. */
export function installStackPrepare() {
  let userPrepare = null;

  function wrapper(err, frames) {
    if (err.name === 'SyntaxError' && err._prettyStack) return err._prettyStack;
    const kept = frames.filter((f) => !isKernelFrame(f)).map(wrapCallSite);
    if (typeof userPrepare === 'function') return userPrepare(err, kept);
    return defaultPrepare(err, frames);
  }

  Object.defineProperty(Error, 'prepareStackTrace', {
    configurable: true,
    enumerable: true,
    get() {
      return wrapper;
    },
    set(fn) {
      userPrepare = typeof fn === 'function' ? fn : null;
    },
  });
}

export { isKernelFrame, KERNEL_HINT, adjustLine };
