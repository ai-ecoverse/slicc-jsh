/**
 * util builtin: Node's util.inspect/format via node-inspect-extracted (MIT),
 * plus promisify / types / isDeepStrictEqual / inherits / deprecate.
 */
import {
  inspect as nodeInspect,
  format as nodeFormat,
  formatWithOptions,
} from 'node-inspect-extracted';

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
    nodeInspect(value, opts).replace(/(^|[,{\s])Symbol\(([^)]*)\):/g, '$1[Symbol($2)]:');
  inspect.custom = INSPECT_CUSTOM;
  inspect.defaultOptions = nodeInspect.defaultOptions ?? { depth: 2, colors: false };

  return {
    inspect,
    format: nodeFormat,
    formatWithOptions,
    promisify,
    types,
    isDeepStrictEqual,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    inherits(ctor, superCtor) {
      Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
      ctor.super_ = superCtor;
    },
    deprecate(fn, msg) {
      let warned = false;
      return function deprecated(...args) {
        if (!warned) {
          warned = true;
          void msg;
        }
        return fn.apply(this, args);
      };
    },
  };
}

export { INSPECT_CUSTOM, PROMISIFY_CUSTOM };
