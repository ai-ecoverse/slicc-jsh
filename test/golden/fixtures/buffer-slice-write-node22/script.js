const r = (f) => {
  try {
    const v = f();
    return Buffer.isBuffer(v) ? `buf:${v.toString('hex')}` : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  } catch (e) {
    return `${e.code}:${e.message}`;
  }
};
const names = Object.getOwnPropertyNames(Buffer.prototype)
  .filter((n) => /Slice$|Write$/.test(n))
  .sort();
console.log('methods', names.join(','));

const sample = Buffer.from('café ¥');
const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const empty = Buffer.alloc(0);
for (const enc of ['utf8', 'latin1', 'ascii', 'hex', 'base64', 'base64url', 'ucs2']) {
  const slice = `${enc}Slice`;
  console.log(
    slice,
    [
      r(() => sample[slice]()),
      r(() => sample[slice](1, 5)),
      r(() => bytes[slice](2, 5)),
      r(() => bytes[slice](5, 2)),
      r(() => bytes[slice](0, 0)),
      r(() => bytes[slice](10)),
      r(() => bytes[slice](11)),
      r(() => bytes[slice](-1)),
      r(() => bytes[slice](0, -1)),
      r(() => bytes[slice](0, 100)),
      r(() => bytes[slice](0, Infinity)),
      r(() => bytes[slice](1.7, 4.2)),
      r(() => bytes[slice](null, undefined)),
      r(() => bytes[slice]('1', '5')),
      r(() => bytes[slice](NaN, 5)),
      r(() => empty[slice]()),
      r(() => empty[slice](1)),
      r(() => empty[slice](-1)),
    ].join(' | ')
  );
}

for (const enc of ['utf8', 'latin1', 'ascii', 'hex', 'base64', 'base64url', 'ucs2']) {
  const write = `${enc}Write`;
  const w = () => Buffer.alloc(10);
  console.log(
    write,
    [
      r(() => {
        const b = w();
        return [b[write]('hi'), b.toString('hex')];
      }),
      r(() => {
        const b = w();
        return [b[write]('abcd', 2), b.toString('hex')];
      }),
      r(() => {
        const b = w();
        return [b[write]('abcdefgh', 2, 3), b.toString('hex')];
      }),
      r(() => {
        const b = w();
        return [b[write]('abcdefghij', 2, 20), b.toString('hex')];
      }),
      r(() => w()[write]('x', -1)),
      r(() => w()[write]('x', 0, -1)),
      r(() => w()[write]('x', 11)),
      r(() => w()[write]('x', 10)),
      r(() => w()[write]('x', 10, 1)),
      r(() => w()[write](1)),
      r(() => {
        const b = w();
        return [b[write]('hi', 0, Infinity), b.toString('hex')];
      }),
      r(() => {
        const b = w();
        return [b[write](''), b.toString('hex')];
      }),
    ].join(' | ')
  );
}

console.log(
  'special',
  [
    r(() => {
      const b = Buffer.alloc(2);
      return [b.utf8Write('€'), b.toString('hex')];
    }),
    r(() => {
      const b = Buffer.alloc(4);
      return [b.hexWrite('abzz'), b.toString('hex')];
    }),
    r(() => {
      const b = Buffer.alloc(4);
      return [b.hexWrite('abcdzz', 0, 1), b.toString('hex')];
    }),
    r(() => {
      const b = Buffer.alloc(3);
      return [b.ucs2Write('ab'), b.toString('hex')];
    }),
    r(() => {
      const b = Buffer.alloc(10);
      return [b.base64Write('aGk='), b.slice(0, 2).toString(), b.toString('hex')];
    }),
    r(() => {
      const b = Buffer.alloc(2);
      return [b.asciiWrite('é'), b.toString('hex')];
    }),
    r(() => {
      const b = Buffer.alloc(2);
      return [b.latin1Write('é'), b.toString('hex')];
    }),
    r(() => Buffer.from('hello').utf8Slice() === Buffer.from('hello').toString('utf8')),
    r(() => {
      const a = Buffer.alloc(8);
      const n = a.write('café', 1, 4, 'utf8');
      const b = Buffer.alloc(8);
      const m = b.utf8Write('café', 1, 4);
      return [n, m, a.equals(b)];
    }),
  ].join(' | ')
);

console.log(
  'order-bigint-descriptors',
  [
    r(() => Buffer.alloc(10).utf8Write(1, -1)),
    r(() => Buffer.alloc(10).utf8Write(1, 0, -1)),
    r(() => Buffer.alloc(10).asciiWrite(1, -1)),
    r(() => Buffer.alloc(10).asciiWrite(1, 0, -1)),
    r(() => Buffer.alloc(10).latin1Write(1, -1)),
    r(() => Buffer.alloc(10).latin1Write(1, 0, -1)),
    r(() => Buffer.alloc(10).hexWrite(1, -1)),
    r(() => Buffer.alloc(10).hexWrite(1, 0, -1)),
    r(() => Buffer.from('hello').utf8Slice(1n)),
    r(() => Buffer.from('hello').utf8Slice({ valueOf() { return 1n; } })),
    r(() => Buffer.from('hello').utf8Slice(0, 1n)),
    r(() => Buffer.alloc(4).utf8Write('x', 1n)),
    r(() => Buffer.alloc(4).hexWrite('ab', 1n)),
    r(() => Buffer.alloc(4).hexWrite('ab', { valueOf() { return 1n; } })),
    r(() =>
      ['utf8Slice', 'hexSlice', 'utf8Write', 'asciiWrite', 'latin1Write', 'hexWrite', 'base64Write', 'ucs2Write'].map((n) => {
        const d = Object.getOwnPropertyDescriptor(Buffer.prototype, n);
        return `${n}:${d.enumerable}:${d.value.length}`;
      })
    ),
  ].join(' | ')
);
