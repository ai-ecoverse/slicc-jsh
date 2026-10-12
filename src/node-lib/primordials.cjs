'use strict';
/**
 * Node's `primordials` (lib/internal/per_context/primordials.js) for the
 * Node lib files in src/node-lib/lib, made on demand from their names:
 *
 * - `Array`, `Symbol`, … : the global itself;
 * - `ArrayIsArray`, `NumberMAX_SAFE_INTEGER`, `SymbolAsyncIterator`: a static
 *   of the longest global prefix (first letter lower-cased unless the rest is
 *   an ALL_CAPS constant);
 * - `ArrayPrototypePush(arr, …)`: the prototype method, uncurried;
 *   `XPrototypeGetY` / `XPrototypeSetY` a getter / setter when X.prototype
 *   has no method `getY`; `XPrototypeSymbolIterator` the Symbol.iterator one;
 * - `SafeMap`, `SafeSet`, `SafeWeakMap`, …, `SafeArrayIterator`,
 *   `SafeStringIterator`, `SafePromiseAll…`, and a few helpers by hand.
 *
 * The primordials exist so Node's code survives a user patching builtins;
 * here they bind at first use, which is what the lib files need to run.
 */

const { apply, getOwnPropertyDescriptor: gopd } = Reflect;
const uncurryThis = (fn) => (thisArg, ...args) => apply(fn, thisArg, args);
const applyBind = (fn) => (thisArg, args) => apply(fn, thisArg, args);

const TypedArray = Object.getPrototypeOf(Uint8Array);
const AsyncIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(async function* () {}).prototype);
const IteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));

const roots = {
  __proto__: null,
  TypedArray,
  AsyncIteratorPrototype,
  IteratorPrototype,
  globalThis,
};
const rootOf = (name) => (name in roots ? roots[name] : globalThis[name]);

function lowerFirst(rest) {
  if (/^[A-Z0-9_]+$/.test(rest) && rest.length > 1) return rest; // MAX_SAFE_INTEGER, EPSILON, PI
  return rest[0].toLowerCase() + rest.slice(1);
}

function symbolKey(rest) {
  if (!rest.startsWith('Symbol')) return undefined;
  const key = lowerFirst(rest.slice(6));
  return typeof Symbol[key] === 'symbol' ? Symbol[key] : undefined;
}

function fromPrototype(proto, rest) {
  const sym = symbolKey(rest);
  if (sym !== undefined) {
    const d = gopdChain(proto, sym);
    if (d && typeof d.value === 'function') return uncurryThis(d.value);
    if (d && d.get) return uncurryThis(d.get);
  }
  const method = lowerFirst(rest);
  const d = gopdChain(proto, method);
  if (d && typeof d.value === 'function') return uncurryThis(d.value);
  for (const [prefix, kind] of [
    ['Get', 'get'],
    ['Set', 'set'],
  ]) {
    if (!rest.startsWith(prefix)) continue;
    const tail = rest.slice(3);
    const key = symbolKey(tail) ?? lowerFirst(tail);
    const acc = gopdChain(proto, key);
    if (acc && acc[kind]) return uncurryThis(acc[kind]);
  }
  if (d && d.get) return uncurryThis(d.get);
  return undefined;
}

function gopdChain(obj, key) {
  for (let o = obj; o != null; o = Object.getPrototypeOf(o)) {
    const d = gopd(o, key);
    if (d) return d;
  }
  return undefined;
}

function makeSafeIterator(Ctor, next) {
  return class SafeIterator {
    constructor(iterable) {
      this._iterator = Ctor(iterable);
    }
    next() {
      return next(this._iterator);
    }
    [Symbol.iterator]() {
      return this;
    }
  };
}

const special = {
  __proto__: null,
  uncurryThis,
  applyBind,
  SafeMap: class SafeMap extends Map {},
  SafeSet: class SafeSet extends Set {},
  SafeWeakMap: class SafeWeakMap extends WeakMap {},
  SafeWeakSet: class SafeWeakSet extends WeakSet {},
  SafeWeakRef: typeof WeakRef === 'function' ? class SafeWeakRef extends WeakRef {} : undefined,
  SafeFinalizationRegistry:
    typeof FinalizationRegistry === 'function' ? class SafeFinalizationRegistry extends FinalizationRegistry {} : undefined,
  SafePromise: Promise,
  SafeArrayIterator: makeSafeIterator(
    (a) => Array.prototype[Symbol.iterator].call(a),
    (it) => it.next()
  ),
  SafeStringIterator: makeSafeIterator(
    (s) => String.prototype[Symbol.iterator].call(s),
    (it) => it.next()
  ),
  SafePromiseAll: (promises, mapFn) => Promise.all(mapFn ? Array.from(promises, mapFn) : promises),
  SafePromiseAllReturnVoid: (promises, mapFn) =>
    Promise.all(mapFn ? Array.from(promises, mapFn) : promises).then(() => undefined),
  SafePromiseAllReturnArrayLike: (promises, mapFn) => Promise.all(mapFn ? Array.from(promises, mapFn) : promises),
  SafePromiseAllSettled: (promises, mapFn) => Promise.allSettled(mapFn ? Array.from(promises, mapFn) : promises),
  SafePromiseAllSettledReturnVoid: (promises, mapFn) =>
    Promise.allSettled(mapFn ? Array.from(promises, mapFn) : promises).then(() => undefined),
  SafePromiseAny: (promises, mapFn) => Promise.any(mapFn ? Array.from(promises, mapFn) : promises),
  SafePromiseRace: (promises, mapFn) => Promise.race(mapFn ? Array.from(promises, mapFn) : promises),
  SafePromisePrototypeFinally: (promise, fn) => Promise.prototype.finally.call(promise, fn),
  PromisePrototypeThen: (promise, onFulfilled, onRejected) =>
    Promise.prototype.then.call(promise, onFulfilled, onRejected),
  hardenRegExp: (re) => re,
  makeSafe: (unsafe, safe) => safe,
  ArrayPrototypeSymbolIterator: uncurryThis(Array.prototype[Symbol.iterator]),
  StringPrototypeSymbolIterator: uncurryThis(String.prototype[Symbol.iterator]),
  TypedArrayPrototypeGetSymbolToStringTag: (v) =>
    ArrayBuffer.isView(v) && !(v instanceof DataView) ? v[Symbol.toStringTag] : undefined,
  FunctionPrototypeSymbolHasInstance: (fn, value) => Function.prototype[Symbol.hasInstance].call(fn, value),
};

function make(name) {
  if (name in special) return special[name];
  // `XApply`: X taking its arguments as an array (MathMaxApply(list),
  // ArrayPrototypePushApply(arr, items)).
  if (name.endsWith('Apply') && name !== 'ReflectApply' && name !== 'FunctionPrototypeApply') {
    const base = make(name.slice(0, -5));
    if (typeof base === 'function') {
      return name.includes('Prototype') ? (thisArg, args) => base(thisArg, ...args) : (args) => base(...args);
    }
  }
  if (name in roots || (Object.prototype.hasOwnProperty.call(globalThis, name) && /^[A-Z]/.test(name))) {
    return rootOf(name);
  }
  // XPrototypeY, with X the longest root that has a prototype.
  for (let at = name.indexOf('Prototype'); at > 0; at = name.indexOf('Prototype', at + 1)) {
    const root = rootOf(name.slice(0, at));
    const rest = name.slice(at + 9);
    if (root == null || !rest) continue;
    const proto = name.slice(0, at).endsWith('Prototype') ? root : root.prototype;
    if (proto == null) continue;
    const fn = fromPrototype(proto, rest);
    if (fn !== undefined) return fn;
  }
  // Statics: the longest global prefix.
  for (let at = name.length - 1; at > 0; at--) {
    if (!/[A-Z]/.test(name[at])) continue;
    const root = rootOf(name.slice(0, at));
    if (root == null || (typeof root !== 'object' && typeof root !== 'function')) continue;
    const rest = name.slice(at);
    const sym = symbolKey(rest);
    if (sym !== undefined && rest !== 'Symbol') return sym;
    const key = lowerFirst(rest);
    if (key in root) {
      const value = root[key];
      return typeof value === 'function' && !/^[A-Z]/.test(key) ? value.bind(root) : value;
    }
  }
  return undefined;
}

const cache = new Map();
module.exports = new Proxy(
  {},
  {
    get(_, name) {
      if (typeof name !== 'string') return undefined;
      if (!cache.has(name)) {
        const value = make(name);
        if (value === undefined) throw new Error(`primordials: no ${name}`);
        cache.set(name, value);
      }
      return cache.get(name);
    },
  }
);
