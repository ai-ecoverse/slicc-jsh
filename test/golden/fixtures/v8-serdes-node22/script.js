// v8.serialize / deserialize and the Serializer / Deserializer API against
// host Node 22: the bytes of each kind of value, what reads back, the errors.
const v8 = require('v8');
const util = require('util');
// A DataView by its bytes: how inspect shows one isn't what this is about.
const show = (v) =>
  v instanceof DataView
    ? `DataView(${v.byteLength}) <${[...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)].join(' ')}>`
    : util.inspect(v, { depth: 5, breakLength: Infinity, showHidden: false });
const fixStack = (e, s = 'STACK') => {
  e.stack = s;
  return e;
};
const hex = (v, S = v8.DefaultSerializer) => {
  try {
    const s = new S();
    s.writeHeader();
    s.writeValue(v);
    return s.releaseBuffer().toString('hex');
  } catch (e) {
    return `THROWS ${e.constructor.name} ${e.code || ''} ${e.message}`;
  }
};
const back = (h) => {
  try {
    return show(v8.deserialize(Buffer.from(h, 'hex')));
  } catch (e) {
    return `THROWS ${e.constructor.name} ${e.code || ''} ${e.message}`;
  }
};

const values = {
  'undefined': undefined,
  'null': null,
  'true': true,
  'false': false,
  'int 0': 0,
  'int -1': -1,
  'int max': 2 ** 31 - 1,
  'int min': -(2 ** 31),
  'int 2**31': 2 ** 31,
  '-0': -0,
  'NaN': NaN,
  'Infinity': -Infinity,
  'fraction': 0.1,
  '1e21': 1e21,
  'bigint 0': 0n,
  'bigint 10': 10n,
  'bigint -5': -5n,
  'bigint 2**70': 2n ** 70n,
  'bigint -(2**64)': -(2n ** 64n),
  'empty string': '',
  'latin1': 'café ÿ',
  'two-byte': 'Ā',
  'two-byte mixed': 'ab€',
  'emoji': '😀!',
  'long string': 'x'.repeat(200),
  'object': { a: 1, b: 'two', c: [3], d: { e: null } },
  'object int keys': { 2: 'a', b: 1, 1: 'c' },
  'object odd keys': { '-1': 1, '4294967295': 2, '4294967294': 3, '01': 4, '2147483648': 5 },
  'object __proto__ key': JSON.parse('{"__proto__": 1}'),
  'symbol keys skipped': { [Symbol('s')]: 1, k: 2 },
  'non-enumerable skipped': Object.defineProperty({ v: 1 }, 'hidden', { value: 2 }),
  'class instance': new (class Foo {
    constructor() {
      this.x = 1;
    }
  })(),
  'getter': {
    get g() {
      return 5;
    },
  },
  'empty array': [],
  'smi array': [1, 2, 3],
  'double array': [1.5, 2],
  'mixed array': [1, 'a', 1.5, null],
  'holey array': [1, , 3],
  'sparse far': Object.assign([], { 5: 1 }),
  'array props': Object.assign([1], { p: 2 }),
  'nested arrays': [[], [[1]], { a: [] }],
  'undefined elements': [undefined, null, true, false],
  'date': new Date(0),
  'date NaN': new Date(NaN),
  'regexp': /a\/b/gimsuyd,
  'regexp v': /[\p{L}--a]/v,
  'boxed': [Object(1), Object('s'), Object(true), Object(false), Object(3n)],
  'map': new Map([
    [1, { x: 1 }],
    ['k', [2]],
  ]),
  'set': new Set(['a', 1, null]),
  'array buffer': new Uint8Array([1, 2, 3]).buffer,
  'resizable array buffer': new ArrayBuffer(2, { maxByteLength: 4 }),
  'uint8array': new Uint8Array([1, 2]),
  'buffer': Buffer.from('ab'),
  'buffer slice': Buffer.from('abcdef').subarray(2, 4),
  'int16array': new Int16Array([-1, 2]),
  'float64array': new Float64Array([0.5]),
  'bigint64array': new BigInt64Array([-1n]),
  'dataview': new DataView(new ArrayBuffer(2)),
  'uint8clamped': new Uint8ClampedArray([300]),
  'error': fixStack(new Error('boom')),
  'range error': fixStack(new RangeError('r')),
  'error cause': fixStack(new TypeError('t', { cause: { why: 1 } })),
  'error cause undefined': fixStack(new Error('c', { cause: undefined })),
  'error no message': fixStack(new Error()),
  'error subclass': fixStack(new (class MyError extends Error {})('q')),
  'error extra props dropped': Object.assign(fixStack(new Error('e')), { extra: 1 }),
};
const errorSelf = fixStack(new Error('self'));
errorSelf.cause = errorSelf;
values['error self cause'] = errorSelf;
const getterName = new Error('x');
Object.defineProperty(getterName, 'name', { get: () => 'TypeError' });
getterName.stack = 5;
values['error name getter, stack not a string'] = getterName;
const messageGetter = fixStack(new TypeError('t'));
Object.defineProperty(messageGetter, 'message', { get: () => 'g' });
values['error message getter'] = messageGetter;

const cyclic = { name: 'c' };
cyclic.self = cyclic;
cyclic.list = [cyclic, { back: cyclic }];
values['cyclic'] = cyclic;
const shared = { s: 1 };
values['shared refs'] = [shared, shared, new Map([[shared, shared]])];
const ab = new ArrayBuffer(8);
values['shared buffer views'] = [new Uint8Array(ab, 0, 2), new Uint8Array(ab, 2, 2)];

// Getters: each runs once, and a property is checked before its getter runs.
const selfDeleting = {
  get x() {
    delete selfDeleting.x;
    return 7;
  },
  y: 1,
};
values['getter deleting itself'] = selfDeleting;
const deletesNext = {};
Object.defineProperty(deletesNext, 'first', {
  enumerable: true,
  get() {
    delete deletesNext.second;
    return 'f';
  },
});
deletesNext.second = 's';
values['getter deleting the next'] = deletesNext;
let reads = 0;
const accessorArray = [1, 2];
Object.defineProperty(accessorArray, 0, { enumerable: true, get: () => ++reads });
values['array with an accessor'] = accessorArray;
values['frozen array'] = Object.freeze([1, 2]);
values['sealed array'] = Object.seal([1, 2]);
values['non-extensible array'] = Object.preventExtensions([1, 2]);
values['read-only element'] = Object.defineProperty([1, 2], 1, { value: 2, writable: false });

for (const [label, value] of Object.entries(values)) {
  const h = hex(value);
  console.log(label.padEnd(36), h);
  if (!h.startsWith('THROWS')) console.log(' '.repeat(36), back(h));
}

console.log('--- refused');
class W extends WeakMap {}
const refused = {
  'function': function f() {},
  'arrow': () => 1,
  'class': class K {},
  'symbol': Symbol('x'),
  'symbol object': Object(Symbol('q')),
  'nested function': { a: () => 2 },
  'weakmap': new WeakMap(),
  'weakmap subclass': new W(),
  'weakset': new WeakSet(),
  'weakref': new WeakRef({}),
  'promise': Promise.resolve(),
  'proxy': new Proxy({}, {}),
  'generator': (function* () {})(),
  'array iterator': [].values(),
  'map iterator': new Map().entries(),
  'arguments': (function () {
    return arguments;
  })(1),
  'globalThis': globalThis,
  'shared array buffer': new SharedArrayBuffer(4),
  'detached': (() => {
    const a = new ArrayBuffer(8);
    structuredClone(a, { transfer: [a] });
    return a;
  })(),
};
for (const [label, value] of Object.entries(refused)) console.log(label.padEnd(24), hex(value));
console.log('accessor element read', reads, 'time(s)');
console.log('prototypes are objects', hex(Promise.prototype), hex(Set.prototype), hex(RegExp.prototype), hex(Math));
console.log('iterator prototypes are objects', hex(Object.getPrototypeOf([].values())), hex(Object.getPrototypeOf(Object.getPrototypeOf([].values()))), hex(Intl.Collator.prototype));
const taggedPromise = Promise.resolve();
taggedPromise[Symbol.toStringTag] = 'X';
const taggedGenerator = (function* () {})();
Object.defineProperty(taggedGenerator, Symbol.toStringTag, { value: 'Y' });
console.log('an own tag hides nothing', hex(taggedPromise), '/', hex(taggedGenerator), '/', hex(new Intl.Collator()));

console.log('--- base Serializer (views as V8 views)');
console.log('view', hex(new Uint8Array([7]), v8.Serializer));
console.log('offset view', hex(new Uint8Array(new ArrayBuffer(8), 2, 3), v8.Serializer));
console.log('dataview', hex(new DataView(new ArrayBuffer(4), 1, 2), v8.Serializer));
{
  const rab = new ArrayBuffer(4, { maxByteLength: 8 });
  const full = new ArrayBuffer(4, { maxByteLength: 4 });
  for (const [label, view] of [
    ['tracking', new Uint8Array(rab)],
    ['tracking from 1', new Uint8Array(rab, 1)],
    ['fixed', new Uint8Array(rab, 0, 2)],
    ['fixed to the end', new Uint8Array(rab, 0, 4)],
    ['tracking 16-bit', new Uint16Array(rab)],
    ['dataview tracking', new DataView(rab)],
    ['dataview fixed', new DataView(rab, 0, 4)],
    ['at its max, tracking', new Uint8Array(full)],
    ['at its max, fixed', new Uint8Array(full, 0, 4)],
    ['at its max, dataview tracking', new DataView(full, 1)],
    ['at its max, dataview fixed', new DataView(full, 1, 3)],
  ]) {
    const h = hex(view, v8.Serializer);
    const d = new v8.Deserializer(Buffer.from(h, 'hex'));
    d.readHeader();
    const back = d.readValue();
    back.buffer.resize(back.buffer.maxByteLength);
    console.log('resizable', label, h, 'read back follows the buffer:', back.byteLength === back.buffer.byteLength - back.byteOffset);
  }
}
const shared2 = new ArrayBuffer(4);
console.log('two views of one buffer', hex([new Uint8Array(shared2), new Uint16Array(shared2, 2)], v8.Serializer));
{
  const s = new v8.Serializer();
  s._setTreatArrayBufferViewsAsHostObjects(true);
  s._getDataCloneError = (m) => new RangeError(`X ${m}`);
  try {
    s.writeValue(new Uint8Array(1));
  } catch (e) {
    console.log('host object, no writer:', e.constructor.name, e.message);
  }
}

console.log('--- reading');
const payloads = {
  'header only': 'ff0f',
  'no header': '4904',
  'version 12': 'ff0c4904',
  'version 13': 'ff0d4904',
  'version 14': 'ff0e4904',
  'version 16': 'ff104904',
  'truncated object': 'ff0f6f',
  'unknown tag': 'ff0f01',
  'utf8 string': 'ff0f5303e282ac',
  'bad utf8': 'ff0f5302ff41',
  'uint32 tag': 'ff0f55ffffffff0f',
  'verify count': 'ff0f3f0349 02'.replace(' ', ''),
  'padding before tag': 'ff0f00004902',
  'duplicate key': 'ff0f6f220161490222016149027b02',
  'wrong property count': 'ff0f6f22016149027b05',
  'bad reference': 'ff0f5e05',
  'odd two-byte length': 'ff0f630361626364',
  'regexp bad flags': 'ff0f52220161ff07',
  'regexp linear flag': 'ff0f5222016140',
  'regexp bad source': 'ff0f522201280100',
  'dense array short': 'ff0f41ff7f',
  'dense array hole': 'ff0f41032d49022d24000003',
  'sparse array': 'ff0f61034900490249044906400203',
  'error no stack': 'ff0f726d2201782e',
  'error unknown tag': 'ff0f72782e',
  'shared array buffer': 'ff0f752a',
  'view on buffer': 'ff0f4204010203045642010200',
  'view out of range': 'ff0f4202010256420105',
  'view misaligned': 'ff0f420401020304565701020000',
  'version 13 view': 'ff0d420201025642000200',
  'host object': 'ff0f5c0b0104000000000000f0bf',
  'map odd length': 'ff0f3b490249043a03',
  'set': 'ff0f2749022c01',
  'string object': 'ff0f73220173',
  'bigint object': 'ff0f7a100300000000000000',
  'object number key': 'ff0f6f4e000000000000f83f49027b01',
  'object bad key': 'ff0f6f5449027b01',
};
for (const [label, h] of Object.entries(payloads)) console.log(label.padEnd(24), back(h));
{
  const e = v8.deserialize(v8.serialize(fixStack(new RangeError('m', { cause: 1 }), 'S')));
  console.log('error read back', e.constructor.name, e.name, e.message, JSON.stringify(e.stack), e.cause, Object.getOwnPropertyNames(e), Object.getOwnPropertyDescriptor(e, 'cause'));
  const s = v8.deserialize(v8.serialize(errorSelf));
  console.log('self cause read back', s.cause === s);
  const c = v8.deserialize(v8.serialize(cyclic));
  console.log('cycle read back', c.self === c, c.list[0] === c, c.list[1].back === c);
  const r = v8.deserialize(v8.serialize(values['shared refs']));
  console.log('refs read back', r[0] === r[1], r[2].get(r[0]) === r[0]);
  const v = v8.deserialize(v8.serialize(values['shared buffer views']));
  console.log('host views read back', v[0].buffer === v[1].buffer, v.map((x) => [x.byteOffset, x.length]));
  const b = v8.deserialize(v8.serialize(Buffer.from('xyz')));
  console.log('buffer read back', Buffer.isBuffer(b), b.toString());
  const o = v8.deserialize(Buffer.from('ff0f6f22095f5f70726f746f5f5f49027b01', 'hex'));
  console.log('__proto__ read back', Object.getOwnPropertyNames(o), Object.getPrototypeOf(o) === Object.prototype);
  const ra = v8.deserialize(v8.serialize(new ArrayBuffer(2, { maxByteLength: 4 })));
  console.log('resizable read back', ra.resizable, ra.maxByteLength, ra.byteLength);
}

console.log('--- the serdes methods');
{
  const s = new v8.Serializer();
  s.writeUint32(-1);
  s.writeUint32('7');
  s.writeUint64(1, 2);
  s.writeUint64(0xffffffff, 0xffffffff);
  s.writeDouble('3');
  s.writeRawBytes(new Uint8Array([9]));
  s.writeRawBytes(new DataView(new Uint8Array([8, 7]).buffer));
  const out = s.releaseBuffer();
  console.log('raw', out.toString('hex'), Buffer.isBuffer(out), out.byteOffset, out.buffer.byteLength === out.length);
  console.log('released again', s.releaseBuffer().length);
  const d = new v8.Deserializer(out);
  console.log('read', d.readUint32(), d.readUint32(), d.readUint64(), d.readUint64(), d.readDouble(), d.readRawBytes(1), d._readRawBytes(2));
  for (const m of ['readUint32', 'readUint64', 'readDouble']) {
    try {
      d[m]();
    } catch (e) {
      console.log(m, 'at end:', e.constructor.name, e.message);
    }
  }
  try {
    d.readRawBytes(1);
  } catch (e) {
    console.log('readRawBytes at end:', e.message);
  }
  for (const [label, fn] of [
    ['writeRawBytes array', () => s.writeRawBytes([1])],
    ['transfer a SharedArrayBuffer', () => s.transferArrayBuffer(1, new SharedArrayBuffer(1))],
    ['Deserializer of a string', () => new v8.Deserializer('x')],
    ['deserialize a string', () => v8.deserialize('x')],
    ['Deserializer transfer a number', () => new v8.Deserializer(Buffer.alloc(1)).transferArrayBuffer(1, 2)],
    ['Serializer without new', () => v8.Serializer()],
    ['Deserializer without new', () => v8.Deserializer(Buffer.alloc(1))],
  ]) {
    try {
      fn();
      console.log(label, 'ok');
    } catch (e) {
      console.log(label, e.constructor.name, e.code, e.message);
    }
  }
  const der = new v8.Deserializer(Buffer.from('ff0f49', 'hex'));
  console.log('deserializer', Object.keys(der), der.buffer.length, der.getWireFormatVersion(), der.readHeader(), der.getWireFormatVersion());
}
{
  const t = new ArrayBuffer(4);
  new Uint8Array(t).set([1, 2, 3, 4]);
  const s = new v8.Serializer();
  s.transferArrayBuffer(7, t);
  s.writeHeader();
  s.writeValue([t, new Uint8Array(t, 1, 2)]);
  const out = s.releaseBuffer();
  console.log('transfer', out.toString('hex'));
  const d1 = new v8.Deserializer(out);
  d1.readHeader();
  try {
    d1.readValue();
  } catch (e) {
    console.log('no transfer given:', e.message);
  }
  const d2 = new v8.Deserializer(out);
  d2.readHeader();
  const into = new ArrayBuffer(4);
  d2.transferArrayBuffer(7, into);
  const got = d2.readValue();
  console.log('transfer read', got[0] === into, got[1].buffer === into, got[1].byteOffset, got[1].length);
}
{
  const s = new v8.Serializer();
  s._getSharedArrayBufferId = (sab) => sab.byteLength * 10;
  s.writeHeader();
  s.writeValue([new SharedArrayBuffer(2), new SharedArrayBuffer(3)]);
  const out = s.releaseBuffer();
  console.log('shared ids', out.toString('hex'));
  const d = new v8.Deserializer(out);
  d.readHeader();
  d.transferArrayBuffer(20, new SharedArrayBuffer(2));
  try {
    d.readValue();
  } catch (e) {
    console.log('shared read:', e.message);
  }
}
{
  class Custom extends v8.Serializer {
    _writeHostObject(o) {
      this.writeUint32(o.length);
    }
  }
  const s = new Custom();
  s._setTreatArrayBufferViewsAsHostObjects(true);
  s.writeHeader();
  s.writeValue({ a: new Uint8Array(3) });
  const out = s.releaseBuffer();
  console.log('custom host', out.toString('hex'));
  class CustomD extends v8.Deserializer {
    _readHostObject() {
      return { len: this.readUint32() };
    }
  }
  const d = new CustomD(out);
  d.readHeader();
  console.log('custom host read', show(d.readValue()));
  const bad = new (class extends v8.Deserializer {
    _readHostObject() {
      return 5;
    }
  })(Buffer.from('ff0f5c', 'hex'));
  bad.readHeader();
  try {
    bad.readValue();
  } catch (e) {
    console.log('host returns a primitive:', e.constructor.name, e.message);
  }
  const none = new v8.Deserializer(Buffer.from('ff0f5c01020102', 'hex'));
  none.readHeader();
  try {
    none.readValue();
  } catch (e) {
    console.log('no reader:', e.constructor.name, e.message);
  }
}
console.log(
  'shape',
  Object.getOwnPropertyNames(v8.Serializer.prototype).sort().join(),
  Object.getOwnPropertyNames(v8.Deserializer.prototype).sort().join(),
  Object.getOwnPropertyNames(v8.DefaultSerializer.prototype).join(),
  Object.getOwnPropertyNames(v8.DefaultDeserializer.prototype).join(),
  v8.Serializer.name,
  v8.Serializer.length,
  v8.Deserializer.length,
  v8.serialize.length,
  v8.deserialize.length,
  v8.Serializer.prototype._getDataCloneError === Error
);
console.log('serialize()', v8.serialize().toString('hex'));
