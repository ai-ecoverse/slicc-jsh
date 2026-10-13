/**
 * util builtin: Node's util.inspect/format via node-inspect-extracted (MIT),
 * plus promisify / types / isDeepStrictEqual / inherits / deprecate.
 */
import {
  inspect as nodeInspect,
  formatWithOptions,
} from 'node-inspect-extracted';

import { validateBoolean, validateNumber, validateObject, validateString } from '../node-errors.mjs';

const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');

function promisify(fn) {
  if (fn?.[PROMISIFY_CUSTOM]) return fn[PROMISIFY_CUSTOM];
  return function promisified(...args) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (err, ...results) => {
        if (err) reject(err);
        else resolve(results.length > 1 ? results : results[0]);
      });
    });
  };
}
promisify.custom = PROMISIFY_CUSTOM;

// Deprecation codes already warned about (Node's codesWarned): one warning
// per code, however many wrappers share it.
const codesWarned = new Set();

/**
 * util.deprecate (lib/internal/util.js): the wrapper warns once, through
 * process.emitWarning, unless process.noDeprecation.
 */
export function deprecate(fn, msg, code) {
  if (code !== undefined) validateString(code, 'code');
  let warned = false;
  function deprecated(...args) {
    const process = globalThis.process;
    if (!process?.noDeprecation && !warned) {
      warned = true;
      if (typeof process?.emitWarning === 'function') {
        if (code !== undefined) {
          if (!codesWarned.has(code)) {
            process.emitWarning(msg, 'DeprecationWarning', code, deprecated);
            codesWarned.add(code);
          }
        } else {
          process.emitWarning(msg, 'DeprecationWarning', deprecated);
        }
      }
    }
    if (new.target) return Reflect.construct(fn, args, new.target);
    return Reflect.apply(fn, this, args);
  }
  Object.setPrototypeOf(deprecated, fn);
  if (fn.prototype) deprecated.prototype = fn.prototype;
  Object.defineProperty(deprecated, 'length', { value: fn.length, configurable: true });
  return deprecated;
}

/**
 * util.getCallSites (Node 22.9+): the caller's frames as plain objects, from
 * the runtime's remapped CallSites (stack.mjs).
 */
function getCallSites(frameCount = 10, options) {
  if (options === undefined && typeof frameCount === 'object' && frameCount !== null) {
    options = frameCount;
    frameCount = 10;
  }
  if (options !== undefined) {
    validateObject(options, 'options');
    if (options.sourceMap !== undefined) validateBoolean(options.sourceMap, 'options.sourceMap');
  }
  validateNumber(frameCount, 'frameCount', 1, 200);
  const prevPrepare = Error.prepareStackTrace;
  const prevLimit = Error.stackTraceLimit;
  const holder = {};
  try {
    // Kernel and loader frames are dropped after capture: capture extra.
    Error.stackTraceLimit = frameCount + 64;
    Error.prepareStackTrace = (_, callSites) => callSites;
    Error.captureStackTrace(holder, getCallSites);
    const sites = holder.stack;
    return (Array.isArray(sites) ? sites : []).slice(0, frameCount).map((site) => ({
      functionName: site.getFunctionName() ?? '',
      scriptId: String(site.getScriptId?.() ?? '0'),
      scriptName: site.getFileName() ?? '',
      lineNumber: site.getLineNumber() ?? 0,
      columnNumber: site.getColumnNumber() ?? 0,
      column: site.getColumnNumber() ?? 0,
    }));
  } finally {
    Error.prepareStackTrace = prevPrepare;
    Error.stackTraceLimit = prevLimit;
  }
}

function isDeepStrictEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return a.toString() === b.toString();
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    if (a.byteLength !== b.byteLength) return false;
    const aa = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const bb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!isDeepStrictEqual(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !isDeepStrictEqual(v, b.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) {
      let found = false;
      for (const w of b) {
        if (isDeepStrictEqual(v, w)) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }
  const ak = Reflect.ownKeys(a);
  const bk = Reflect.ownKeys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!isDeepStrictEqual(a[k], b[k])) return false;
  }
  return true;
}

const types = {
  isDate: (v) => v instanceof Date,
  isRegExp: (v) => v instanceof RegExp,
  isNativeError: (v) => v instanceof Error,
  isBuffer: (v) => v?.constructor?.name === 'Buffer' || (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(v)),
  isArrayBuffer: (v) => v instanceof ArrayBuffer,
  isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isUint8Array: (v) => v instanceof Uint8Array,
  isPromise: (v) => v instanceof Promise || (v && typeof v.then === 'function'),
  isMap: (v) => v instanceof Map,
  isSet: (v) => v instanceof Set,
};

export function createUtil() {
  // node-inspect-extracted lags Node 22's Symbol-key brackets: `[Symbol(s)]:`.
  const inspect = (value, opts) =>
    nodeInspect(value, opts)
      .replace(/(^|[,{\s])Symbol\(([^)]*)\):/g, '$1[Symbol($2)]:')
      // node-inspect-extracted brackets ArrayBuffer.byteLength; Node 22 does not.
      .replace(/\[byteLength\]:/g, 'byteLength:');
  inspect.custom = INSPECT_CUSTOM;
  // Node's inspect.colors / styles / defaultOptions (shared with the inspector underneath).
  inspect.colors = nodeInspect.colors;
  inspect.styles = nodeInspect.styles;
  Object.defineProperty(inspect, 'defaultOptions', {
    get: () => nodeInspect.defaultOptions,
    set: (options) => {
      nodeInspect.defaultOptions = options;
    },
    enumerable: true,
    configurable: true,
  });

  /**
   * Node's formatWithOptionsInternal (lib/internal/util/inspect.js), over the
   * inspect above so objects print as util.inspect prints them. Primitive
   * placeholders (%d %i %f %j, %s of a non-object) go to the vendored format,
   * which has no objects to show.
   */
  const stringOf = (v) => {
    try {
      return String(v);
    } catch {
      return undefined;
    }
  };
  function formatWithOptionsInternal(inspectOptions, args) {
    const first = args[0];
    let a = 0;
    let str = '';
    let join = '';
    if (typeof first === 'string') {
      if (args.length === 1) return first;
      let tempStr;
      let lastPos = 0;
      for (let i = 0; i < first.length - 1; i++) {
        if (first.charCodeAt(i) !== 37) continue; // '%'
        const nextChar = first.charCodeAt(++i);
        if (a + 1 !== args.length) {
          switch (nextChar) {
            case 115: {
              // 's': an object with a built-in toString is inspected (depth 0)
              const arg = args[++a];
              tempStr = formatWithOptions(inspectOptions ?? {}, '%s', arg);
              if (typeof arg === 'object' && arg !== null && tempStr !== stringOf(arg)) {
                tempStr = inspect(arg, { ...inspectOptions, depth: 0, colors: false, compact: 3 });
              }
              break;
            }
            case 106: // 'j'
            case 100: // 'd'
            case 105: // 'i'
            case 102: // 'f'
              tempStr = formatWithOptions(inspectOptions ?? {}, `%${String.fromCharCode(nextChar)}`, args[++a]);
              break;
            case 79: // 'O'
              tempStr = inspect(args[++a], inspectOptions);
              break;
            case 111: // 'o'
              tempStr = inspect(args[++a], { ...inspectOptions, showHidden: true, showProxy: true, depth: 4 });
              break;
            case 99: // 'c'
              a += 1;
              tempStr = '';
              break;
            case 37: // '%'
              str += first.slice(lastPos, i);
              lastPos = i + 1;
              continue;
            default:
              continue;
          }
          if (lastPos !== i - 1) str += first.slice(lastPos, i - 1);
          str += tempStr;
          lastPos = i + 1;
        } else if (nextChar === 37) {
          str += first.slice(lastPos, i);
          lastPos = i + 1;
        }
      }
      if (lastPos !== 0) {
        a++;
        join = ' ';
        if (lastPos < first.length) str += first.slice(lastPos);
      }
    }
    while (a < args.length) {
      const value = args[a];
      str += join;
      str += typeof value !== 'string' ? inspect(value, inspectOptions) : value;
      join = ' ';
      a++;
    }
    return str;
  }
  const format = (...args) => formatWithOptionsInternal(undefined, args);
  function formatWithOptionsChecked(inspectOptions, ...args) {
    // Node: validateObject(inspectOptions, 'inspectOptions', kValidateObjectAllowArray).
    formatWithOptions(inspectOptions);
    return formatWithOptionsInternal(inspectOptions, args);
  }

  return {
    inspect,
    format,
    formatWithOptions: formatWithOptionsChecked,
    promisify,
    types,
    isDeepStrictEqual,
    getCallSites,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    inherits(ctor, superCtor) {
      Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
      ctor.super_ = superCtor;
    },
    deprecate,
  };
}

export { INSPECT_CUSTOM, PROMISIFY_CUSTOM };
