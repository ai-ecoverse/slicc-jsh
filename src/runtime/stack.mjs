/**
 * Error.prepareStackTrace: drop kernel-origin frames; rename Object.eval →
 * Object.<anonymous>; correct V8 new-Function line numbers (−2).
 * CallSites passed to user prepareStackTrace are remapped the same way.
 *
 * Do NOT fabricate node:internal/modules/cjs/loader frames — jsh has no such
 * module; those CallSites are filtered as kernel frames.
 */

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
  if (isLoaderImplFrame(frame)) return true;
  const file = frame.getFileName?.() || '';
  const text = typeof frame.toString === 'function' ? frame.toString() : '';
  const fn = frame.getFunctionName?.() || '';
  if (KERNEL_HINT.test(file) || KERNEL_HINT.test(text) || KERNEL_HINT.test(fn)) return true;
  if (file.startsWith('data:')) return true;
  // Never surface fabricated or accidental node:internal frames from the shim.
  if (file.startsWith('node:internal')) return true;
  if (text.includes('node:internal')) return true;
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
  if (file.startsWith('node:internal')) return null;
  return file;
}

/** Parse name / path:line:col from CallSite.toString (getters are often empty with sourceURL). */
function parseSite(frame) {
  const text = typeof frame.toString === 'function' ? frame.toString() : '';
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

  const method = frame.getMethodName?.();
  const typeName = frame.getTypeName?.();

  let fn = frame.getFunctionName?.() || null;
  if (fn === 'eval' || fn === 'Object.eval') fn = 'Object.<anonymous>';
  if (fn === '<anonymous>') fn = null;

  // Prefer Type.method when V8 reports a method call (Timeout._onTimeout).
  // Do not trust parsed.toString names — they may already say Object.<anonymous>.
  if (method && typeName && typeName !== 'Object') {
    fn = `${typeName}.${method}`;
  } else if (!fn) {
    fn = parsed?.name || null;
    if (fn === '<anonymous>') fn = null;
  }
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
  const hasName = !!(fn && fn !== 'Object.<anonymous>');
  const isToplevel = !ctor && !hasName && (v8Top ?? true);

  if (ctor && parsed?.name && (!fn || fn === 'Object.<anonymous>')) fn = parsed.name;
  if (ctor && fn === 'Object.<anonymous>') fn = parsed?.name || fn;

  return {
    getThis: () => frame.getThis?.(),
    getTypeName: () => (ctor ? null : typeName),
    getFunction: () => frame.getFunction?.(),
    getFunctionName: () => {
      if (fn === 'Object.<anonymous>') return null;
      if (isToplevel && !ctor) return null;
      if (fn?.startsWith('Object.') && !ctor) return fn.slice(7);
      // Timeout._onTimeout: CallSite function name stays null; method carries it.
      if (fn && method && typeName && fn === `${typeName}.${method}`) return null;
      return fn;
    },
    getMethodName: () => method,
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

function stackHeader(err) {
  // Node: empty message → "Error" (no colon); captureStackTrace({}) → "Error".
  const name = err?.name || 'Error';
  const msg = err?.message;
  if (msg === undefined || msg === '') return name;
  return `${name}: ${msg}`;
}

function defaultPrepare(err, frames) {
  if (err.name === 'SyntaxError' && err._prettyStack) return err._prettyStack;
  const kept = frames.filter((f) => !isKernelFrame(f));
  return [stackHeader(err), ...kept.map((f) => formatFrame(wrapCallSite(f)))].join('\n');
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
