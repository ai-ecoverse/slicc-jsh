/**
 * V8's ValueSerializer wire format (version 15, V8 12.4's
 * src/objects/value-serializer.cc) in JS, behind the API Node 22's serdes
 * binding (src/node_serdes.cc) gives lib/v8.js: v8.Serializer and
 * v8.Deserializer. Bytes are V8's for the same value, so a payload written
 * here reads in Node and the other way round.
 *
 * Where V8 decides on its object layout, which a program can't see, this
 * follows what a literal gives:
 * - a number is an int32 (`I`) when it is one (and not -0), else a double
 *   (`N`). V8 writes a double for an integral value it happens to hold as a
 *   heap number, such as an object field that held a fraction before;
 * - an array is dense (`A`) when it has no holes and plain elements in an
 *   extensible array, else sparse (`a`), as V8's elements kinds give. V8
 *   also writes `new Array(n)` filled later as sparse (its elements stay
 *   holey).
 *   A dense array of numbers only is written as doubles when one isn't an
 *   int32, as V8's double elements are;
 * - a view of a growable SharedArrayBuffer is written as fixed-length (V8
 *   knows whether one follows the buffer; finding out here would grow it);
 * - nothing is a host object (V8's embedder fields). A Proxy is refused, as
 *   in V8, when it was made through the runtime's Proxy (run.mjs tracks
 *   them, as for util.types.isProxy).
 * Reading has none of these limits: every value V8 writes reads back.
 */
import nodeInspect from 'node-inspect-extracted';
import { nodeError } from '../node-errors.mjs';

const kLatestVersion = 15;
const kMinimumVersion = 13; // Node reads no legacy (pre-13) data.

const T = {
  version: 0xff,
  padding: 0x00,
  verifyObjectCount: 0x3f, // ?
  theHole: 0x2d, // -
  undefined: 0x5f, // _
  null: 0x30, // 0
  true: 0x54, // T
  false: 0x46, // F
  int32: 0x49, // I
  uint32: 0x55, // U
  double: 0x4e, // N
  bigint: 0x5a, // Z
  utf8String: 0x53, // S
  oneByteString: 0x22, // "
  twoByteString: 0x63, // c
  objectReference: 0x5e, // ^
  beginJSObject: 0x6f, // o
  endJSObject: 0x7b, // {
  beginSparseJSArray: 0x61, // a
  endSparseJSArray: 0x40, // @
  beginDenseJSArray: 0x41, // A
  endDenseJSArray: 0x24, // $
  date: 0x44, // D
  trueObject: 0x79, // y
  falseObject: 0x78, // x
  numberObject: 0x6e, // n
  bigintObject: 0x7a, // z
  stringObject: 0x73, // s
  regexp: 0x52, // R
  beginJSMap: 0x3b, // ;
  endJSMap: 0x3a, // :
  beginJSSet: 0x27, // '
  endJSSet: 0x2c, // ,
  arrayBuffer: 0x42, // B
  resizableArrayBuffer: 0x7e, // ~
  arrayBufferTransfer: 0x74, // t
  arrayBufferView: 0x56, // V
  sharedArrayBuffer: 0x75, // u
  sharedObject: 0x70, // p
  hostObject: 0x5c, // \
  error: 0x72, // r
};

// ArrayBufferViewTag, by constructor name.
const VIEW_TAGS = {
  Int8Array: 0x62,
  Uint8Array: 0x42,
  Uint8ClampedArray: 0x43,
  Int16Array: 0x77,
  Uint16Array: 0x57,
  Int32Array: 0x64,
  Uint32Array: 0x44,
  Float16Array: 0x68,
  Float32Array: 0x66,
  Float64Array: 0x46,
  BigInt64Array: 0x71,
  BigUint64Array: 0x51,
  DataView: 0x3f,
};
const VIEW_BY_TAG = new Map();
for (const [name, tag] of Object.entries(VIEW_TAGS)) {
  if (typeof globalThis[name] === 'function') VIEW_BY_TAG.set(tag, globalThis[name]);
}

const E = {
  eval: 0x45, // E
  range: 0x52, // R
  reference: 0x46, // F
  syntax: 0x53, // S
  type: 0x54, // T
  uri: 0x55, // U
  message: 0x6d, // m
  cause: 0x63, // c
  stack: 0x73, // s
  end: 0x2e, // .
};
const ERROR_TAGS = {
  EvalError: E.eval,
  RangeError: E.range,
  ReferenceError: E.reference,
  SyntaxError: E.syntax,
  TypeError: E.type,
  URIError: E.uri,
};
const ERROR_BY_TAG = new Map([
  [E.eval, EvalError],
  [E.range, RangeError],
  [E.reference, ReferenceError],
  [E.syntax, SyntaxError],
  [E.type, TypeError],
  [E.uri, URIError],
]);

// JSRegExp::Flags bits (kFlagCount 9; kLinear, bit 6, is the experimental engine's).
const REGEXP_FLAGS = [
  ['g', 1],
  ['i', 2],
  ['m', 4],
  ['y', 8],
  ['u', 16],
  ['s', 32],
  ['d', 128],
  ['v', 256],
];
const REGEXP_BAD_FLAGS = ~0x1ff | 64;

const { getPrototypeOf, getOwnPropertyDescriptor, defineProperty, hasOwn, keys: objectKeys } = Object;
const objectToString = Object.prototype.toString;
const functionToString = Function.prototype.toString;
const getter = (proto, name) => getOwnPropertyDescriptor(proto, name).get;
const arrayBufferByteLength = getter(ArrayBuffer.prototype, 'byteLength');
const arrayBufferDetached = getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached')?.get;
const arrayBufferResizable = getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const arrayBufferMaxByteLength = getOwnPropertyDescriptor(ArrayBuffer.prototype, 'maxByteLength')?.get;
const sharedByteLength = typeof SharedArrayBuffer === 'function' ? getter(SharedArrayBuffer.prototype, 'byteLength') : null;
const TypedArrayPrototype = getPrototypeOf(Uint8Array.prototype);
const typedArrayName = getter(TypedArrayPrototype, Symbol.toStringTag);
const typedArrayBuffer = getter(TypedArrayPrototype, 'buffer');
const typedArrayByteOffset = getter(TypedArrayPrototype, 'byteOffset');
const typedArrayByteLength = getter(TypedArrayPrototype, 'byteLength');
const dataViewBuffer = getter(DataView.prototype, 'buffer');
const dataViewByteOffset = getter(DataView.prototype, 'byteOffset');
const dataViewByteLength = getter(DataView.prototype, 'byteLength');
const mapSize = getter(Map.prototype, 'size');
const setSize = getter(Set.prototype, 'size');
const mapEntries = Map.prototype.entries;
const setValues = Set.prototype.values;
const mapSet = Map.prototype.set;
const setAdd = Set.prototype.add;
const dateGetTime = Date.prototype.getTime;
const regexpSource = getter(RegExp.prototype, 'source');
const regexpFlags = getter(RegExp.prototype, 'flags');
const numberValueOf = Number.prototype.valueOf;
const stringValueOf = String.prototype.valueOf;
const booleanValueOf = Boolean.prototype.valueOf;
const bigintValueOf = BigInt.prototype.valueOf;
const symbolValueOf = Symbol.prototype.valueOf;
const weakMapHas = WeakMap.prototype.has;
const weakSetHas = WeakSet.prototype.has;
const weakRefDeref = typeof WeakRef === 'function' ? WeakRef.prototype.deref : null;
const registryUnregister = typeof FinalizationRegistry === 'function' ? FinalizationRegistry.prototype.unregister : null;

/** Whether `fn.call(value, ...args)` works: a brand check on a builtin's internal slot. */
function branded(fn, value, ...args) {
  if (fn === null || fn === undefined) return false;
  try {
    Reflect.apply(fn, value, args);
    return true;
  } catch {
    return false;
  }
}

// Builtins V8 refuses that have no side-effect-free brand check: known by
// the builtin prototype that tags them (its Symbol.toStringTag), found up
// the object's chain. An own tag doesn't hide one, and the prototypes
// themselves are ordinary objects to V8. (So is an object made with one of
// them as its prototype, such as a generator function's own `prototype`:
// refused here.)
const REFUSED_PROTOTYPES = new Map();
{
  const add = (proto) => {
    if (proto === null || typeof proto !== 'object') return;
    const desc = getOwnPropertyDescriptor(proto, Symbol.toStringTag);
    const tag = desc && 'value' in desc ? desc.value : undefined;
    if (typeof tag === 'string') REFUSED_PROTOTYPES.set(proto, tag);
  };
  const tryAdd = (make) => {
    try {
      add(make());
    } catch {
      /* not in this engine */
    }
  };
  add(Promise.prototype);
  tryAdd(() => getPrototypeOf(getPrototypeOf((function* () {})())));
  tryAdd(() => getPrototypeOf(getPrototypeOf((async function* () {})())));
  tryAdd(() => getPrototypeOf([][Symbol.iterator]()));
  tryAdd(() => getPrototypeOf(new Map().entries()));
  tryAdd(() => getPrototypeOf(new Set().values()));
  tryAdd(() => getPrototypeOf(''[Symbol.iterator]()));
  tryAdd(() => getPrototypeOf(/a/[Symbol.matchAll]('')));
  tryAdd(() => getPrototypeOf([].values().map((x) => x)));
  tryAdd(() => getPrototypeOf(new Intl.Segmenter().segment('')[Symbol.iterator]()));
  for (const name of Object.getOwnPropertyNames(globalThis.Intl ?? {})) {
    if (typeof Intl[name] === 'function') tryAdd(() => Intl[name].prototype);
  }
  for (const name of Object.getOwnPropertyNames(globalThis.WebAssembly ?? {})) {
    if (typeof WebAssembly[name] === 'function') tryAdd(() => WebAssembly[name].prototype);
  }
}
const REFUSED_PROTOTYPE_SET = new Set(REFUSED_PROTOTYPES.keys());

/** A data property found along the prototype chain, without running a getter (V8's GetDataProperty). */
function dataProperty(object, key) {
  for (let at = object; at !== null && at !== undefined; at = getPrototypeOf(at)) {
    const desc = getOwnPropertyDescriptor(at, key);
    if (desc) return 'value' in desc ? desc.value : undefined;
  }
  return undefined;
}

/** V8's Object::NoSideEffectsToString, for the DataCloneError messages. */
function describe(value) {
  if (typeof value === 'symbol') return String(value);
  if (typeof value === 'function') {
    try {
      return Reflect.apply(functionToString, value, []);
    } catch {
      return 'function () { [native code] }';
    }
  }
  if (value === null || typeof value !== 'object') return String(value);
  try {
    if (dataProperty(value, 'toString') === objectToString) {
      const ctor = dataProperty(value, 'constructor');
      if (typeof ctor === 'function') {
        const desc = getOwnPropertyDescriptor(ctor, 'name');
        const name = desc && typeof desc.value === 'string' ? desc.value : '';
        if (name) return `#<${name}>`;
      }
    }
    const tag = dataProperty(value, Symbol.toStringTag);
    if (typeof tag === 'string') return `[object ${tag}]`;
    return Reflect.apply(objectToString, value, []);
  } catch {
    return '#<Object>';
  }
}

/** A builtin object V8 refuses to serialize (callables, exotic and special receivers). */
function refused(object) {
  if (typeof object === 'function') return true;
  if (nodeInspect.Proxy.getProxyDetails(object, false) !== undefined) return true;
  if (object === globalThis) return true;
  if (branded(weakMapHas, object, {}) || branded(weakSetHas, object, {})) return true;
  if (branded(weakRefDeref, object) || branded(registryUnregister, object, {})) return true;
  if (branded(symbolValueOf, object)) return true;
  // A module namespace object.
  if (getPrototypeOf(object) === null && getOwnPropertyDescriptor(object, Symbol.toStringTag)?.value === 'Module') return true;
  if (REFUSED_PROTOTYPE_SET.has(object)) return false;
  for (let at = getPrototypeOf(object); at !== null; at = getPrototypeOf(at)) {
    if (REFUSED_PROTOTYPE_SET.has(at)) return true;
  }
  // An arguments object (its builtin tag; it has no prototype of its own).
  try {
    return !hasOwn(object, Symbol.toStringTag) && Reflect.apply(objectToString, object, []) === '[object Arguments]';
  } catch {
    return false;
  }
}

/** Canonical array index (0 … 2**32 - 2) of a property key, or -1. */
function arrayIndex(key) {
  if (key.length === 0 || key.length > 10) return -1;
  const n = Number(key);
  if (!(n >= 0 && n <= 4294967294) || String(n) !== key) return -1;
  return n;
}

const isInt32 = (n) => (n | 0) === n && !Object.is(n, -0);

class Writer {
  constructor() {
    this.buffer = new Uint8Array(0);
    this.size = 0;
  }
  reserve(bytes) {
    const at = this.size;
    const need = at + bytes;
    if (need > this.buffer.length) {
      const grown = new Uint8Array(Math.max(need, this.buffer.length * 2) + 64);
      grown.set(this.buffer.subarray(0, at));
      this.buffer = grown;
    }
    this.size = need;
    return at;
  }
  byte(b) {
    // reserve() may replace this.buffer: take the index first.
    const at = this.reserve(1);
    this.buffer[at] = b;
  }
  bytes(src) {
    const at = this.reserve(src.length);
    this.buffer.set(src, at);
  }
  varint(value) {
    // value: a non-negative integer number (up to 2**32 - 1)
    let v = value >>> 0;
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v) b |= 0x80;
      this.byte(b);
    } while (v);
  }
  varint64(value) {
    // value: a BigInt in 0 … 2**64 - 1
    let v = BigInt.asUintN(64, value);
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v) b |= 0x80;
      this.byte(b);
    } while (v);
  }
  zigzag(value) {
    this.varint(((value << 1) ^ (value >> 31)) >>> 0);
  }
  double(value) {
    const at = this.reserve(8);
    new DataView(this.buffer.buffer).setFloat64(at, value, true);
  }
  release() {
    const out = this.buffer.slice(0, this.size);
    this.buffer = new Uint8Array(0);
    this.size = 0;
    return out;
  }
}

const varintLength = (value) => {
  let n = 0;
  let v = value >>> 0;
  do {
    n++;
    v >>>= 7;
  } while (v);
  return n;
};

const DESERIALIZE_FAILED = Symbol('deserialize failed');

export function createSerdes({ Buffer }) {
  const plainError = (message) => new Error(message);

  const notConstructed = (name) =>
    nodeError(TypeError, 'ERR_CONSTRUCT_CALL_REQUIRED', `Class constructor ${name} cannot be invoked without 'new'`);
  const invalidArg = (message) => nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', message);

  const kState = Symbol('serializer state');

  /** v8.Serializer: Node's SerializerContext, with this object as V8's delegate. */
  function Serializer() {
    if (!new.target) throw notConstructed('Serializer');
    defineProperty(this, kState, {
      value: { out: new Writer(), ids: new Map(), nextId: 0, transfers: new Map(), viewsAsHost: false },
    });
  }

  function stateOf(self) {
    const state = self?.[kState];
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  // Node's ThrowDataCloneError: the delegate's _getDataCloneError makes the error.
  function cloneError(self, message) {
    return Reflect.apply(self._getDataCloneError, self, [message]);
  }
  const notCloned = (self, value) => cloneError(self, `${describe(value)} could not be cloned.`);

  function writeString(out, string) {
    let oneByte = true;
    for (let i = 0; i < string.length; i++) {
      if (string.charCodeAt(i) > 0xff) {
        oneByte = false;
        break;
      }
    }
    if (oneByte) {
      out.byte(T.oneByteString);
      out.varint(string.length);
      const at = out.reserve(string.length);
      for (let i = 0; i < string.length; i++) out.buffer[at + i] = string.charCodeAt(i);
      return;
    }
    const byteLength = string.length * 2;
    // V8's reader expects two-byte strings aligned.
    if ((out.size + 1 + varintLength(byteLength)) & 1) out.byte(T.padding);
    out.byte(T.twoByteString);
    out.varint(byteLength);
    const at = out.reserve(byteLength);
    for (let i = 0; i < string.length; i++) {
      const c = string.charCodeAt(i);
      out.buffer[at + 2 * i] = c & 0xff;
      out.buffer[at + 2 * i + 1] = c >> 8;
    }
  }

  function writeBigIntContents(out, value) {
    const negative = value < 0n;
    let magnitude = negative ? -value : value;
    const digits = [];
    while (magnitude > 0n) {
      digits.push(BigInt.asUintN(64, magnitude));
      magnitude >>= 64n;
    }
    const byteLength = digits.length * 8;
    out.varint(((byteLength << 1) | (negative ? 1 : 0)) >>> 0);
    const at = out.reserve(byteLength);
    const view = new DataView(out.buffer.buffer);
    digits.forEach((d, i) => view.setBigUint64(at + i * 8, d, true));
  }

  function writeNumber(out, value) {
    if (isInt32(value)) {
      out.byte(T.int32);
      out.zigzag(value);
    } else {
      out.byte(T.double);
      out.double(value);
    }
  }

  function writeKey(out, key) {
    const index = arrayIndex(key);
    if (index >= 0) writeNumber(out, index);
    else writeString(out, key);
  }

  function viewInfo(view) {
    // The tag getter gives undefined (no throw) for a DataView.
    const name = Reflect.apply(typedArrayName, view, []);
    if (name !== undefined) {
      return {
        name,
        buffer: Reflect.apply(typedArrayBuffer, view, []),
        byteOffset: Reflect.apply(typedArrayByteOffset, view, []),
        byteLength: Reflect.apply(typedArrayByteLength, view, []),
      };
    }
    return {
      name: 'DataView',
      buffer: Reflect.apply(dataViewBuffer, view, []),
      byteOffset: Reflect.apply(dataViewByteOffset, view, []),
      byteLength: Reflect.apply(dataViewByteLength, view, []),
    };
  }

  function writeObject(self, state, value) {
    const { out } = state;
    switch (typeof value) {
      case 'undefined':
        out.byte(T.undefined);
        return;
      case 'boolean':
        out.byte(value ? T.true : T.false);
        return;
      case 'number':
        writeNumber(out, value);
        return;
      case 'bigint':
        out.byte(T.bigint);
        writeBigIntContents(out, value);
        return;
      case 'string':
        writeString(out, value);
        return;
      case 'symbol':
        throw notCloned(self, value);
      default:
        break;
    }
    if (value === null) {
      out.byte(T.null);
      return;
    }
    // A view's buffer goes first, before the view gets its id (V8's quirk).
    if (ArrayBuffer.isView(value) && !state.ids.has(value) && !state.viewsAsHost) {
      writeReceiver(self, state, viewInfo(value).buffer);
    }
    writeReceiver(self, state, value);
  }

  function writeReceiver(self, state, object) {
    const { out, ids } = state;
    const seen = ids.get(object);
    if (seen !== undefined) {
      out.byte(T.objectReference);
      out.varint(seen);
      return;
    }
    ids.set(object, state.nextId++);
    if (refused(object)) throw notCloned(self, object);

    if (Array.isArray(object)) return writeArray(self, state, object);
    if (ArrayBuffer.isView(object)) return writeView(self, state, object);
    if (branded(arrayBufferByteLength, object)) return writeArrayBuffer(self, state, object);
    if (sharedByteLength && branded(sharedByteLength, object)) {
      if (typeof self._getSharedArrayBufferId !== 'function') {
        throw plainError(`${describe(object)} could not be cloned.`);
      }
      const id = Reflect.apply(self._getSharedArrayBufferId, self, [object]) >>> 0;
      out.byte(T.sharedArrayBuffer);
      out.varint(id);
      return;
    }
    if (branded(dateGetTime, object)) {
      out.byte(T.date);
      out.double(Reflect.apply(dateGetTime, object, []));
      return;
    }
    if (object !== RegExp.prototype && branded(regexpSource, object)) {
      out.byte(T.regexp);
      writeString(out, Reflect.apply(regexpSource, object, []));
      const flags = Reflect.apply(regexpFlags, object, []);
      let bits = 0;
      for (const [f, bit] of REGEXP_FLAGS) if (flags.includes(f)) bits |= bit;
      out.varint(bits);
      return;
    }
    if (branded(mapSize, object)) {
      const entries = [];
      for (const [k, v] of Reflect.apply(mapEntries, object, [])) entries.push(k, v);
      out.byte(T.beginJSMap);
      for (const item of entries) writeObject(self, state, item);
      out.byte(T.endJSMap);
      out.varint(entries.length);
      return;
    }
    if (branded(setSize, object)) {
      const items = [...Reflect.apply(setValues, object, [])];
      out.byte(T.beginJSSet);
      for (const item of items) writeObject(self, state, item);
      out.byte(T.endJSSet);
      out.varint(items.length);
      return;
    }
    if (writeWrapper(state, object)) return;
    if (isError(object)) return writeError(self, state, object);
    writeJSObject(self, state, object);
  }

  function isError(object) {
    if (typeof Error.isError === 'function') return Error.isError(object);
    try {
      return Reflect.apply(objectToString, object, []) === '[object Error]';
    } catch {
      return false;
    }
  }

  function writeWrapper(state, object) {
    const { out } = state;
    if (branded(booleanValueOf, object)) {
      out.byte(Reflect.apply(booleanValueOf, object, []) ? T.trueObject : T.falseObject);
    } else if (branded(numberValueOf, object)) {
      out.byte(T.numberObject);
      out.double(Reflect.apply(numberValueOf, object, []));
    } else if (branded(bigintValueOf, object)) {
      out.byte(T.bigintObject);
      writeBigIntContents(out, Reflect.apply(bigintValueOf, object, []));
    } else if (branded(stringValueOf, object)) {
      out.byte(T.stringObject);
      writeString(out, Reflect.apply(stringValueOf, object, []));
    } else {
      return false;
    }
    return true;
  }

  function writeProperties(self, state, object, keys) {
    let written = 0;
    for (const key of keys) {
      // A getter run before may have deleted it: then it isn't written. Its
      // own getter's value is written, whatever the getter does.
      if (!hasOwn(object, key)) continue;
      const value = object[key];
      writeKey(state.out, key);
      writeObject(self, state, value);
      written++;
    }
    return written;
  }

  function writeJSObject(self, state, object) {
    const keys = objectKeys(object);
    state.out.byte(T.beginJSObject);
    const written = writeProperties(self, state, object, keys);
    state.out.byte(T.endJSObject);
    state.out.varint(written);
  }

  function writeArray(self, state, array) {
    const { out } = state;
    const length = array.length >>> 0;
    const keys = objectKeys(array);
    let indices = 0;
    while (indices < keys.length && arrayIndex(keys[indices]) >= 0) indices++;
    // V8 writes fast elements densely: no holes, plain data elements (an
    // accessor, or a frozen, sealed or non-extensible array, has other
    // elements kinds). Decided from descriptors: no getter runs for it.
    let dense = indices === length && Object.isExtensible(array);
    const values = dense ? new Array(length) : null;
    for (let i = 0; dense && i < length; i++) {
      const desc = getOwnPropertyDescriptor(array, i);
      if (!desc || !('value' in desc) || !desc.writable || !desc.configurable) dense = false;
      else values[i] = desc.value;
    }
    if (!dense) {
      out.byte(T.beginSparseJSArray);
      out.varint(length);
      const written = writeProperties(self, state, array, keys);
      out.byte(T.endSparseJSArray);
      out.varint(written);
      out.varint(length);
      return;
    }
    out.byte(T.beginDenseJSArray);
    out.varint(length);
    // Double elements: numbers only, one of them not an int32.
    const doubles = length > 0 && values.every((v) => typeof v === 'number') && !values.every(isInt32);
    for (let i = 0; i < length; i++) {
      // Writing an element can change the array: as V8, read each one as it
      // is now, a missing one being a hole.
      const desc = getOwnPropertyDescriptor(array, i);
      if (!desc) {
        out.byte(T.theHole);
        continue;
      }
      const element = 'value' in desc ? desc.value : array[i];
      if (doubles && typeof element === 'number') {
        out.byte(T.double);
        out.double(element);
      } else {
        writeObject(self, state, element);
      }
    }
    const written = writeProperties(self, state, array, keys.slice(indices));
    out.byte(T.endDenseJSArray);
    out.varint(written);
    out.varint(length);
  }

  function writeArrayBuffer(self, state, buffer) {
    const { out } = state;
    const transfer = state.transfers.get(buffer);
    if (transfer !== undefined) {
      out.byte(T.arrayBufferTransfer);
      out.varint(transfer);
      return;
    }
    if (arrayBufferDetached && Reflect.apply(arrayBufferDetached, buffer, [])) {
      throw cloneError(self, 'An ArrayBuffer is detached and could not be cloned.');
    }
    const byteLength = Reflect.apply(arrayBufferByteLength, buffer, []);
    if (arrayBufferResizable && Reflect.apply(arrayBufferResizable, buffer, [])) {
      out.byte(T.resizableArrayBuffer);
      out.varint(byteLength);
      out.varint(Reflect.apply(arrayBufferMaxByteLength, buffer, []));
    } else {
      out.byte(T.arrayBuffer);
      out.varint(byteLength);
    }
    out.bytes(new Uint8Array(buffer, 0, byteLength));
  }

  function writeView(self, state, view) {
    const { out } = state;
    if (state.viewsAsHost) {
      out.byte(T.hostObject);
      if (typeof self._writeHostObject !== 'function') {
        throw plainError(`${describe(view)} could not be cloned.`);
      }
      Reflect.apply(self._writeHostObject, self, [view]);
      return;
    }
    const info = viewInfo(view);
    const rab = !!(arrayBufferResizable && branded(arrayBufferResizable, info.buffer) && Reflect.apply(arrayBufferResizable, info.buffer, []));
    const tracking = rab && lengthTracking(view, info);
    out.byte(T.arrayBufferView);
    out.varint(VIEW_TAGS[info.name]);
    out.varint(info.byteOffset);
    // A length-tracking view's length is the buffer's: V8 writes 0.
    out.varint(tracking ? 0 : info.byteLength);
    // JSArrayBufferViewIsLengthTracking (bit 0), JSArrayBufferViewIsBackedByRab (bit 1).
    out.varint((tracking ? 1 : 0) | (rab ? 2 : 0));
  }

  /**
   * Whether a view of a resizable ArrayBuffer follows its length (made
   * without one). JS can't ask; a structured clone (the platform's keeps
   * it, with a copy of the buffer) is resized to see. A growable
   * SharedArrayBuffer's clone would share the memory, so its views are
   * written as fixed-length.
   */
  function lengthTracking(view, info) {
    let clone;
    try {
      clone = structuredClone(view);
    } catch {
      return false;
    }
    const buffer = clone.buffer;
    const max = buffer.maxByteLength;
    const size = view.BYTES_PER_ELEMENT ?? 1;
    const lengthOf = () => (clone instanceof DataView ? clone.byteLength : Reflect.apply(typedArrayByteLength, clone, []));
    // Grown to the most it can be, a tracking view covers the rest of it.
    const followed = Math.floor((max - info.byteOffset) / size) * size;
    if (followed !== info.byteLength) {
      buffer.resize(max);
      return lengthOf() !== info.byteLength;
    }
    if (info.byteLength === 0) return false;
    // It covers the rest already: cut to where it starts, a fixed view is
    // out of bounds, a tracking one empty.
    // (An out-of-bounds DataView's byteLength throws; a typed array's fill does.)
    buffer.resize(info.byteOffset);
    try {
      if (clone instanceof DataView) lengthOf();
      else Reflect.apply(TypedArrayPrototype.fill, clone, [0]);
      return true;
    } catch {
      return false;
    }
  }

  function writeError(self, state, error) {
    const { out } = state;
    const messageDesc = getOwnPropertyDescriptor(error, 'message');
    const causeDesc = getOwnPropertyDescriptor(error, 'cause');
    out.byte(T.error);
    const name = String(error.name);
    if (hasOwn(ERROR_TAGS, name)) out.varint(ERROR_TAGS[name]);
    if (messageDesc && 'value' in messageDesc) {
      const message = String(messageDesc.value);
      out.varint(E.message);
      writeString(out, message);
    }
    const stack = error.stack;
    if (typeof stack === 'string') {
      out.varint(E.stack);
      writeString(out, stack);
    }
    // After the rest, so the error exists before a cause that refers to it.
    if (causeDesc && 'value' in causeDesc) {
      out.varint(E.cause);
      writeObject(self, state, causeDesc.value);
    }
    out.varint(E.end);
  }

  const serializerMethods = {
    writeHeader() {
      const { out } = stateOf(this);
      out.byte(T.version);
      out.varint(kLatestVersion);
    },
    writeValue(value) {
      writeObject(this, stateOf(this), value);
      return true;
    },
    releaseBuffer() {
      const bytes = stateOf(this).out.release();
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
    transferArrayBuffer(id, arrayBuffer) {
      const state = stateOf(this);
      const n = Number(id) >>> 0;
      if (!branded(arrayBufferByteLength, arrayBuffer)) throw invalidArg('arrayBuffer must be an ArrayBuffer');
      state.transfers.set(arrayBuffer, n);
    },
    writeUint32(value) {
      stateOf(this).out.varint(Number(value) >>> 0);
    },
    writeUint64(hi, lo) {
      const state = stateOf(this);
      const h = Number(hi) >>> 0;
      const l = Number(lo) >>> 0;
      state.out.varint64((BigInt(h) << 32n) | BigInt(l));
    },
    writeDouble(value) {
      stateOf(this).out.double(Number(value));
    },
    writeRawBytes(source) {
      const state = stateOf(this);
      if (!ArrayBuffer.isView(source)) throw invalidArg('source must be a TypedArray or a DataView');
      state.out.bytes(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
    },
    _setTreatArrayBufferViewsAsHostObjects(value) {
      stateOf(this).viewsAsHost = !!value;
    },
  };
  for (const [name, fn] of Object.entries(serializerMethods)) {
    defineProperty(Serializer.prototype, name, { value: fn, writable: true, configurable: true, enumerable: false });
  }

  const kRead = Symbol('deserializer state');

  /** v8.Deserializer: Node's DeserializerContext, with this object as V8's delegate. */
  function Deserializer(buffer) {
    if (!new.target) throw notConstructed('Deserializer');
    if (!ArrayBuffer.isView(buffer)) throw invalidArg('buffer must be a TypedArray or a DataView');
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    defineProperty(this, kRead, {
      value: { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), pos: 0, version: 0, ids: [], nextId: 0, transfers: null, broken13: false },
    });
    this.buffer = buffer;
  }

  function readOf(self) {
    const state = self?.[kRead];
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  const fail = () => {
    throw DESERIALIZE_FAILED;
  };

  function readTag(r) {
    let tag;
    do {
      if (r.pos >= r.bytes.length) fail();
      tag = r.bytes[r.pos++];
    } while (tag === T.padding);
    return tag;
  }

  function peekTag(r) {
    let at = r.pos;
    let tag;
    do {
      if (at >= r.bytes.length) return -1;
      tag = r.bytes[at++];
    } while (tag === T.padding);
    return tag;
  }

  // V8's ReadVarint<T>: an unrolled read (at most sizeof(T) + 1 bytes) away
  // from the end, the checked loop near it; both cut the value to T's bits.
  function readVarint(r, bits = 32) {
    const { bytes } = r;
    const width = bits / 8;
    const mask = bits === 32 ? (v) => v >>> 0 : (v) => v & 0xff;
    let value = 0;
    if (r.pos + width + 1 < bytes.length) {
      for (let shift = 0; shift < bits; shift += 7) {
        const b = bytes[r.pos++];
        value = mask(value | ((b & 0x7f) * 2 ** shift));
        if (b < 0x80) return value;
      }
      return value;
    }
    let shift = 0;
    let more;
    do {
      if (r.pos >= bytes.length) fail();
      const b = bytes[r.pos];
      more = b & 0x80;
      if (shift < bits) {
        value = mask(value | ((b & 0x7f) * 2 ** shift));
        shift += 7;
      } else {
        return value;
      }
      r.pos++;
    } while (more);
    return value;
  }

  function readVarint64(r) {
    const { bytes } = r;
    let value = 0n;
    let shift = 0n;
    let more;
    do {
      if (r.pos >= bytes.length) fail();
      const b = bytes[r.pos];
      more = b & 0x80;
      if (shift < 64n) {
        value |= BigInt(b & 0x7f) << shift;
        shift += 7n;
      } else {
        return BigInt.asUintN(64, value);
      }
      r.pos++;
    } while (more);
    return BigInt.asUintN(64, value);
  }

  function readZigZag(r) {
    const u = readVarint(r);
    return (u >>> 1) ^ -(u & 1);
  }

  function readDouble(r) {
    if (r.pos + 8 > r.bytes.length) fail();
    const v = r.view.getFloat64(r.pos, true);
    r.pos += 8;
    return v;
  }

  function readRaw(r, length) {
    if (length > r.bytes.length - r.pos) fail();
    const at = r.pos;
    r.pos += length;
    return at;
  }

  const utf8 = new TextDecoder('utf-8');
  function readStringBody(r, tag) {
    const length = readVarint(r);
    const at = readRaw(r, length);
    const raw = r.bytes.subarray(at, at + length);
    if (tag === T.utf8String) return utf8.decode(raw);
    if (tag === T.oneByteString) {
      let s = '';
      for (let i = 0; i < raw.length; i += 8192) s += String.fromCharCode(...raw.subarray(i, i + 8192));
      return s;
    }
    if (length % 2) fail();
    let s = '';
    const codes = new Array(Math.min(length / 2, 8192));
    for (let i = 0; i < length / 2; ) {
      let n = 0;
      for (; n < codes.length && i < length / 2; n++, i++) codes[n] = raw[2 * i] | (raw[2 * i + 1] << 8);
      codes.length = n;
      s += String.fromCharCode(...codes);
    }
    return s;
  }

  function readBigIntBody(r) {
    const bitfield = readVarint(r);
    const byteLength = bitfield >>> 1;
    // V8's DigitsByteLengthForBitfield: the length rounded down to whole digits.
    const digits = Math.floor(byteLength / 8);
    const at = readRaw(r, byteLength);
    let value = 0n;
    for (let i = digits - 1; i >= 0; i--) value = (value << 64n) | r.view.getBigUint64(at + i * 8, true);
    return bitfield & 1 ? -value : value;
  }

  function readString(self, r) {
    const value = readObject(self, r);
    if (typeof value !== 'string') fail();
    return value;
  }

  function addObject(r, id, object) {
    r.ids[id] = object;
  }

  function objectWithId(r, id) {
    if (!hasOwn(r.ids, id)) fail();
    return r.ids[id];
  }

  function readObject(self, r) {
    let result = readObjectInternal(self, r);
    if (branded(arrayBufferByteLength, result) || (sharedByteLength && branded(sharedByteLength, result))) {
      if (peekTag(r) === T.arrayBufferView) {
        readTag(r);
        result = readView(r, result);
      }
    }
    return result;
  }

  function readObjectInternal(self, r) {
    const tag = readTag(r);
    switch (tag) {
      case T.verifyObjectCount:
        readVarint(r);
        return readObject(self, r);
      case T.undefined:
        return undefined;
      case T.null:
        return null;
      case T.true:
        return true;
      case T.false:
        return false;
      case T.int32:
        return readZigZag(r);
      case T.uint32:
        return readVarint(r);
      case T.double:
        return readDouble(r);
      case T.bigint:
        return readBigIntBody(r);
      case T.utf8String:
      case T.oneByteString:
      case T.twoByteString:
        return readStringBody(r, tag);
      case T.objectReference:
        return objectWithId(r, readVarint(r));
      case T.beginJSObject: {
        const id = r.nextId++;
        const object = {};
        addObject(r, id, object);
        const n = readProperties(self, r, object, T.endJSObject);
        if (readVarint(r) !== n) fail();
        return object;
      }
      case T.beginSparseJSArray: {
        const length = readVarint(r);
        const id = r.nextId++;
        const array = [];
        array.length = length;
        addObject(r, id, array);
        const n = readProperties(self, r, array, T.endSparseJSArray);
        if (readVarint(r) !== n || readVarint(r) !== length) fail();
        return array;
      }
      case T.beginDenseJSArray:
        return readDenseArray(self, r);
      case T.date: {
        const time = readDouble(r);
        const date = new Date(time);
        addObject(r, r.nextId++, date);
        return date;
      }
      case T.trueObject:
      case T.falseObject:
      case T.numberObject:
      case T.bigintObject:
      case T.stringObject: {
        const id = r.nextId++;
        let value;
        if (tag === T.trueObject) value = Object(true);
        else if (tag === T.falseObject) value = Object(false);
        else if (tag === T.numberObject) value = Object(readDouble(r));
        else if (tag === T.bigintObject) value = Object(readBigIntBody(r));
        else value = Object(readString(self, r));
        addObject(r, id, value);
        return value;
      }
      case T.regexp: {
        const id = r.nextId++;
        const source = readString(self, r);
        const bits = readVarint(r);
        if (bits & REGEXP_BAD_FLAGS) fail();
        let flags = '';
        for (const [f, bit] of REGEXP_FLAGS) if (bits & bit) flags += f;
        // A bad pattern's SyntaxError is thrown as is, as V8's JSRegExp::New does.
        const regexp = new RegExp(source, flags);
        addObject(r, id, regexp);
        return regexp;
      }
      case T.beginJSMap: {
        const id = r.nextId++;
        const map = new Map();
        addObject(r, id, map);
        let length = 0;
        for (;;) {
          const next = peekTag(r);
          if (next < 0) fail();
          if (next === T.endJSMap) {
            readTag(r);
            break;
          }
          const k = readObject(self, r);
          const v = readObject(self, r);
          Reflect.apply(mapSet, map, [k, v]);
          length += 2;
        }
        if (readVarint(r) !== length) fail();
        return map;
      }
      case T.beginJSSet: {
        const id = r.nextId++;
        const set = new Set();
        addObject(r, id, set);
        let length = 0;
        for (;;) {
          const next = peekTag(r);
          if (next < 0) fail();
          if (next === T.endJSSet) {
            readTag(r);
            break;
          }
          Reflect.apply(setAdd, set, [readObject(self, r)]);
          length++;
        }
        if (readVarint(r) !== length) fail();
        return set;
      }
      case T.arrayBuffer:
      case T.resizableArrayBuffer: {
        const id = r.nextId++;
        const byteLength = readVarint(r);
        let maxByteLength = byteLength;
        if (tag === T.resizableArrayBuffer) {
          maxByteLength = readVarint(r);
          if (byteLength > maxByteLength) fail();
        }
        const at = readRaw(r, byteLength);
        const buffer =
          tag === T.resizableArrayBuffer ? new ArrayBuffer(byteLength, { maxByteLength }) : new ArrayBuffer(byteLength);
        new Uint8Array(buffer).set(r.bytes.subarray(at, at + byteLength));
        addObject(r, id, buffer);
        return buffer;
      }
      case T.arrayBufferTransfer: {
        const id = r.nextId++;
        const transferId = readVarint(r);
        if (!r.transfers || !r.transfers.has(transferId)) fail();
        const buffer = r.transfers.get(transferId);
        addObject(r, id, buffer);
        return buffer;
      }
      case T.sharedArrayBuffer:
        // Node's delegate has no GetSharedArrayBufferFromId.
        r.nextId++;
        readVarint(r);
        return fail();
      case T.error:
        return readError(self, r);
      case T.hostObject:
        return readHostObject(self, r);
      default:
        return fail();
    }
  }

  function readProperties(self, r, object, endTag) {
    let n = 0;
    for (;;) {
      const next = peekTag(r);
      if (next < 0) fail();
      if (next === endTag) {
        readTag(r);
        return n;
      }
      const key = readObject(self, r);
      if (typeof key !== 'string' && typeof key !== 'number') fail();
      const value = readObject(self, r);
      if (hasOwn(object, key)) fail();
      defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
      n++;
    }
  }

  function readDenseArray(self, r) {
    const length = readVarint(r);
    if (length > r.bytes.length - r.pos) fail();
    const id = r.nextId++;
    const array = new Array(length);
    addObject(r, id, array);
    for (let i = 0; i < length; i++) {
      if (peekTag(r) === T.theHole) {
        readTag(r);
        continue;
      }
      array[i] = readObject(self, r);
    }
    const n = readProperties(self, r, array, T.endDenseJSArray);
    if (readVarint(r) !== n || readVarint(r) !== length) fail();
    return array;
  }

  function readView(r, buffer) {
    const isShared = sharedByteLength && branded(sharedByteLength, buffer);
    const bufferByteLength = isShared ? Reflect.apply(sharedByteLength, buffer, []) : Reflect.apply(arrayBufferByteLength, buffer, []);
    const tag = readVarint(r, 8);
    const byteOffset = readVarint(r);
    const byteLength = readVarint(r);
    if (byteOffset > bufferByteLength || byteLength > bufferByteLength - byteOffset) fail();
    let flags = 0;
    if (r.version >= 14 || r.broken13) flags = readVarint(r);
    const id = r.nextId++;
    const Ctor = VIEW_BY_TAG.get(tag);
    if (!Ctor) fail();
    const lengthTracking = (flags & 1) !== 0;
    const backedByRab = (flags & 2) !== 0;
    const resizable = !isShared && arrayBufferResizable && Reflect.apply(arrayBufferResizable, buffer, []);
    const growable = isShared && typeof buffer.growable === 'boolean' && buffer.growable;
    if ((lengthTracking || backedByRab) && !(resizable || growable)) fail();
    if (backedByRab && isShared) fail();
    if (resizable && !backedByRab) fail();
    let view;
    if (Ctor === DataView) {
      view = lengthTracking ? new DataView(buffer, byteOffset) : new DataView(buffer, byteOffset, byteLength);
    } else {
      const size = Ctor.BYTES_PER_ELEMENT;
      if (byteOffset % size || byteLength % size) fail();
      view = lengthTracking ? new Ctor(buffer, byteOffset) : new Ctor(buffer, byteOffset, byteLength / size);
    }
    addObject(r, id, view);
    return view;
  }

  function readError(self, r) {
    const id = r.nextId++;
    let tag = readVarint(r, 8);
    let Ctor = Error;
    if (ERROR_BY_TAG.has(tag)) {
      Ctor = ERROR_BY_TAG.get(tag);
      tag = readVarint(r, 8);
    }
    let message;
    if (tag === E.message) {
      message = readString(self, r);
      tag = readVarint(r, 8);
    }
    let stack;
    if (tag === E.stack) {
      stack = readString(self, r);
      tag = readVarint(r, 8);
    }
    const error = message === undefined ? new Ctor() : new Ctor(message);
    defineProperty(error, 'stack', { value: stack, writable: true, enumerable: false, configurable: true });
    addObject(r, id, error);
    if (tag === E.cause) {
      const cause = readObject(self, r);
      defineProperty(error, 'cause', { value: cause, writable: true, enumerable: false, configurable: true });
      tag = readVarint(r, 8);
    }
    if (tag !== E.end) fail();
    return error;
  }

  function readHostObject(self, r) {
    const id = r.nextId++;
    if (typeof self._readHostObject !== 'function') fail();
    const object = Reflect.apply(self._readHostObject, self, []);
    if (object === null || (typeof object !== 'object' && typeof object !== 'function')) {
      throw new TypeError('readHostObject must return an object');
    }
    addObject(r, id, object);
    return object;
  }

  const unableToDeserialize = () => new Error('Unable to deserialize cloned data.');

  const deserializerMethods = {
    readHeader() {
      const r = readOf(this);
      if (r.pos < r.bytes.length && r.bytes[r.pos] === T.version) {
        r.pos++;
        let version;
        try {
          version = readVarint(r);
        } catch (err) {
          if (err !== DESERIALIZE_FAILED) throw err;
          version = Infinity;
        }
        if (version > kLatestVersion) {
          throw new Error('Unable to deserialize cloned data due to invalid or unsupported version.');
        }
        r.version = version;
      }
      if (r.version < kMinimumVersion) {
        throw new Error('Unable to deserialize cloned data due to invalid or unsupported version.');
      }
      return true;
    },
    readValue() {
      const r = readOf(this);
      const start = r.pos;
      const ids = r.nextId;
      try {
        return readObject(this, r);
      } catch (err) {
        if (err !== DESERIALIZE_FAILED) throw err;
      }
      // Version 13 wrote view flags it didn't say it had: V8 reads it again so.
      if (r.version === 13 && !r.broken13) {
        r.broken13 = true;
        r.pos = start;
        r.nextId = ids;
        try {
          return readObject(this, r);
        } catch (err) {
          if (err !== DESERIALIZE_FAILED) throw err;
        }
      }
      throw unableToDeserialize();
    },
    transferArrayBuffer(id, arrayBuffer) {
      const r = readOf(this);
      const n = Number(id) >>> 0;
      const ok = branded(arrayBufferByteLength, arrayBuffer) || (sharedByteLength && branded(sharedByteLength, arrayBuffer));
      if (!ok) throw invalidArg('arrayBuffer must be an ArrayBuffer or SharedArrayBuffer');
      (r.transfers ??= new Map()).set(n, arrayBuffer);
    },
    getWireFormatVersion() {
      return readOf(this).version;
    },
    readUint32() {
      const r = readOf(this);
      try {
        return readVarint(r);
      } catch (err) {
        if (err !== DESERIALIZE_FAILED) throw err;
        throw new Error('ReadUint32() failed');
      }
    },
    readUint64() {
      const r = readOf(this);
      let value;
      try {
        value = readVarint64(r);
      } catch (err) {
        if (err !== DESERIALIZE_FAILED) throw err;
        throw new Error('ReadUint64() failed');
      }
      return [Number(value >> 32n), Number(value & 0xffffffffn)];
    },
    readDouble() {
      const r = readOf(this);
      try {
        return readDouble(r);
      } catch (err) {
        if (err !== DESERIALIZE_FAILED) throw err;
        throw new Error('ReadDouble() failed');
      }
    },
    _readRawBytes(length) {
      const r = readOf(this);
      const n = Math.trunc(Number(length)) || 0;
      if (n < 0 || n > r.bytes.length - r.pos) throw new Error('ReadRawBytes() failed');
      return readRaw(r, n);
    },
  };
  for (const [name, fn] of Object.entries(deserializerMethods)) {
    defineProperty(Deserializer.prototype, name, { value: fn, writable: true, configurable: true, enumerable: false });
  }

  return { Serializer, Deserializer };
}
