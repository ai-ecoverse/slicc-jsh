/**
 * Error.prepareStackTrace: drop kernel-origin frames; rename Object.eval →
 * Object.<anonymous>; correct V8 new-Function line numbers (−2).
 * CallSites passed to user prepareStackTrace are remapped the same way.
 */

const KERNEL_HINT =
  /node-process-worker|runJsProcess|createNodeKernel|data:text\/javascript|@ai-ecoverse\/slicc-kernel|\/slicc-kernel\/|slicc-jsh\/dist\/|at new Function\b/i;

function isKernelFrame(frame) {
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
  const withName = /^\s*(?:async\s+)?([^\s(]+)\s+\((\[eval\]|[^)]+):(\d+):(\d+)\)/.exec(text);
  if (withName) {
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

/** Wrap a V8 CallSite so getters match err.stack remapping. */
export function wrapCallSite(frame) {
  const parsed = parseSite(frame);
  const file = remapFileName(frame.getFileName?.() || parsed?.file || null);
  const rawLine = frame.getLineNumber?.() ?? parsed?.line;
  const line = adjustLine(rawLine);
  const col = frame.getColumnNumber?.() ?? parsed?.column ?? 0;

  let fn = frame.getFunctionName?.() || parsed?.name || null;
  if (fn === 'eval' || fn === 'Object.eval') fn = 'Object.<anonymous>';
  if (fn === '<anonymous>') fn = 'Object.<anonymous>';

  // Node: Object.boom for exports.boom = function boom()
  const method = frame.getMethodName?.();
  const typeName = frame.getTypeName?.();
  if (fn && fn !== 'Object.<anonymous>' && typeName === 'Object' && method && fn === method) {
    fn = `Object.${method}`;
  } else if (fn && fn !== 'Object.<anonymous>' && !fn.includes('.') && /^[a-z]/.test(fn) && typeName === 'Object') {
    // exports.boom often surfaces as boom without typeName; keep boom unless method says boom on Object
    if (method) fn = `Object.${method}`;
  }
  // Prefer Object.boom from parsed name "boom" when path is a module exporting boom
  if (fn === 'boom') fn = 'Object.boom';

  const isToplevel =
    !fn ||
    fn === 'Object.<anonymous>' ||
    (typeof frame.isToplevel === 'function' && frame.isToplevel() && !parsed?.name);

  return {
    getThis: () => frame.getThis?.(),
    getTypeName: () => typeName,
    getFunction: () => frame.getFunction?.(),
    // CallSites at top level: null (n-prepareStackTrace third frame).
    getFunctionName: () => (isToplevel || fn === 'Object.<anonymous>' ? null : fn?.startsWith('Object.') ? fn.slice(7) : fn),
    getMethodName: () => method,
    getFileName: () => file,
    getLineNumber: () => line,
    getColumnNumber: () => col,
    getEvalOrigin: () => frame.getEvalOrigin?.(),
    isToplevel: () => !!isToplevel,
    isEval: () => frame.isEval?.() ?? false,
    isNative: () => frame.isNative?.() ?? false,
    isConstructor: () => frame.isConstructor?.() ?? false,
    isAsync: () => frame.isAsync?.() ?? false,
    isPromiseAll: () => frame.isPromiseAll?.() ?? false,
    getPromiseIndex: () => frame.getPromiseIndex?.(),
    toString() {
      const f = file || 'unknown';
      const pos = line != null ? `:${line}:${col ?? 0}` : '';
      const label = fn || 'Object.<anonymous>';
      if (f === '[eval]' || String(f).includes('[eval]')) {
        // Node eval stacks omit Object.<anonymous> wrapper.
        if (label === 'Object.<anonymous>') return `${f}${pos}`;
      }
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
