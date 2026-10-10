/** Minimal util: inspect, promisify, format, types. */

const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');

function inspect(value, opts = {}) {
  const maxDepth = opts.depth === undefined ? 2 : opts.depth;
  return inspectValue(value, 0, { seen: new Set(), maxDepth, opts });
}

function inspectValue(val, depth, ctx) {
  if (val === null) return 'null';
  const t = typeof val;
  if (t === 'string') return `'${val.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (t === 'number') return Object.is(val, -0) ? '-0' : String(val);
  if (t === 'bigint') return `${val}n`;
  if (t === 'boolean' || t === 'undefined') return String(val);
  if (t === 'symbol') return val.toString();
  if (t === 'function') {
    const name = val.name;
    return name ? `[Function: ${name}]` : '[Function (anonymous)]';
  }
  if (val instanceof RegExp) return val.toString();
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? 'Invalid Date' : val.toISOString();
  if (val instanceof Error) return val.stack || `${val.name}: ${val.message}`;
  if (ctx.seen.has(val)) return '[Circular]';
  if (ctx.maxDepth !== null && depth > ctx.maxDepth) {
    return Array.isArray(val) ? '[Array]' : '[Object]';
  }
  ctx.seen.add(val);
  try {
    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      return `[ ${val.map((v) => inspectValue(v, depth + 1, ctx)).join(', ')} ]`;
    }
    const keys = Object.keys(val);
    if (keys.length === 0) return '{}';
    const items = keys.map((k) => `${k}: ${inspectValue(val[k], depth + 1, ctx)}`);
    return `{ ${items.join(', ')} }`;
  } finally {
    ctx.seen.delete(val);
  }
}

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

function format(fmt, ...args) {
  if (typeof fmt !== 'string') return [fmt, ...args].map((a) => inspect(a)).join(' ');
  let i = 0;
  const out = fmt.replace(/%[sdjifoO%]/g, (token) => {
    if (token === '%%') return '%';
    if (i >= args.length) return token;
    const arg = args[i++];
    switch (token) {
      case '%s':
        return String(arg);
      case '%d':
      case '%i':
        return String(Number(arg));
      case '%j':
        try {
          return JSON.stringify(arg);
        } catch {
          return '[Circular]';
        }
      default:
        return inspect(arg);
    }
  });
  const rest = args.slice(i).map((a) => inspect(a));
  return rest.length ? `${out} ${rest.join(' ')}` : out;
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
  return {
    inspect,
    promisify,
    format,
    types,
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
          // Avoid depending on a global console; callers may still see the warning later.
          void msg;
        }
        return fn.apply(this, args);
      };
    },
  };
}

export { INSPECT_CUSTOM, PROMISIFY_CUSTOM };
