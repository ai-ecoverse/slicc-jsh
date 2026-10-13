const r = (f) => { try { const v = f(); return Buffer.isBuffer(v) ? `buf:${v.toString('hex')}` : String(v); } catch (e) { return `${e.code}:${e.message}`; } };
const encs = [undefined, null, '', 0, 5, 'UTF-8', 'Latin1', 'binary', 'UCS2', 'utf-16le', 'BASE64', 'hex', 'HEX', 'bogus', 'utf8 ', true, {}];
const show = (e) => (typeof e === 'string' ? JSON.stringify(e) : typeof e === 'object' && e ? '{}' : String(e));
for (const e of encs) {
  const b = () => Buffer.from('hi');
  console.log(show(e).padEnd(12), [
    r(() => Buffer.from('hi', e)),
    r(() => b().toString(e)),
    r(() => b().toString(e, 0, 1)),
    r(() => { const x = b(); x.write('a', e); return x; }),
    r(() => { const x = b(); x.write('a', 0, e); return x; }),
    r(() => { const x = b(); x.write('a', 0, 1, e); return x; }),
    r(() => b().fill('a', e)),
    r(() => b().fill('a', 0, 2, e)),
    r(() => Buffer.alloc(2, 'a', e)),
    r(() => Buffer.byteLength('hi', e)),
    r(() => b().indexOf('i', 0, e)),
    r(() => b().lastIndexOf('i', 1, e)),
    r(() => b().includes('i', 0, e)),
  ].join(' | '));
}
const t = (label, f) => { try { const v = f(); console.log(label, Buffer.isBuffer(v) ? v.toString('hex') : JSON.stringify(v)); } catch (e) { console.log(label, 'THROWS', e.name, e.code, e.message); } };
// unknown encodings throw ERR_UNKNOWN_ENCODING where Node's do
t('from bogus', () => Buffer.from('hi', 'bogus'));
t('toString bogus', () => Buffer.from('hi').toString('bogus'));
t('toString object', () => Buffer.from('hi').toString({ a: 1 }));
t('isEncoding', () => ['bogus', 'UCS-2', '', 'BASE64URL', 'utf-16LE', 5].map((e) => Buffer.isEncoding(e)));
t('byteLength', () => [['aGk=', 'base64'], ['abc', 'hex'], ['€', 'utf8'], ['€', 'latin1'], ['ab', 'ucs2'], ['x', 'bogus'], ['YQ', 'base64url']].map(([s, e]) => Buffer.byteLength(s, e)));
t('byteLength bad', () => Buffer.byteLength(5));
// base64: forgiving, both alphabets, stops at '='
for (const s of ['a', 'aGk!!', 'aG k\n=', 'aGk=aGk', 'YQ', 'Y', '-_8', '+/8=', 'a====b', '']) t(`base64 ${JSON.stringify(s)}`, () => [Buffer.from(s, 'base64').toString('hex'), Buffer.from(s, 'base64url').toString('hex')]);
t('base64 out', () => [Buffer.from([0xfb, 0xff]).toString('base64'), Buffer.from([0xfb, 0xff]).toString('base64url')]);
// ascii drops the high bit; latin1 keeps a byte
t('ascii', () => [Buffer.from([0xe9, 0x41]).toString('ascii'), Buffer.from('é', 'ascii').toString('hex'), Buffer.from('\u0100', 'latin1').toString('hex')]);
// toString ranges
const abc = Buffer.from('abcdef');
t('toString ranges', () => [abc.toString('utf8', -1, 2), abc.toString('utf8', 2.7, 4.2), abc.toString('utf8', 4, 2), abc.toString('utf8', 10), abc.toString(undefined, 1), abc.toString('hex', '1', '3')]);
// write: whole characters only
t('write euro in 2', () => { const b = Buffer.alloc(2); return [b.write('€'), b.toString('hex')]; });
t('write ucs2 odd', () => { const b = Buffer.alloc(3); return [b.write('ab', 'ucs2'), b.toString('hex')]; });
t('write hex', () => { const b = Buffer.alloc(3); return [b.write('abcdzz', 'hex'), b.toString('hex')]; });
t('write non-string', () => Buffer.alloc(2).write(5));
t('write offset float', () => Buffer.alloc(2).write('a', 0.5));
t('write length > remaining', () => { const b = Buffer.alloc(3); return [b.write('abcd', 1, 3), b.toString()]; });
// fill
t('fill hex invalid', () => Buffer.alloc(2).fill('zz', 'hex'));
t('fill empty string', () => Buffer.alloc(2, 1).fill(''));
t('fill multi', () => Buffer.alloc(5).fill('ab', 1));
t('fill offset >= end', () => Buffer.alloc(3).fill('a', 2, 1));
t('fill end out of range', () => Buffer.alloc(3).fill('a', 0, 4));
t('fill buffer', () => Buffer.alloc(5).fill(Buffer.from('xy')));
t('fill empty buffer', () => Buffer.alloc(2).fill(Buffer.alloc(0)));
// indexOf / lastIndexOf / includes
const b = Buffer.from('abcabc');
for (const [v, o] of [['', 0], ['', 10], ['', -1], ['c', -1], ['c', -3], ['c', 100], ['c', -100], ['a', undefined], ['bc', null], ['x', 0], ['bc', '1']]) {
  t(`indexOf ${JSON.stringify(v)} ${o}`, () => [b.indexOf(v, o), b.lastIndexOf(v, o), b.includes(v, o)]);
}
t('lastIndexOf', () => [b.lastIndexOf('c'), b.lastIndexOf(99), b.indexOf(99, 3), b.lastIndexOf(Buffer.from('ab')), b.indexOf(Buffer.from('')), b.lastIndexOf(Buffer.from('')), b.indexOf(355)]);
t('indexOf object', () => b.indexOf({}));
const u = Buffer.from('abcd', 'ucs2');
t('ucs2 search', () => [u.indexOf('c', 'ucs2'), u.indexOf('c', 0, 'ucs2'), u.lastIndexOf('a', 'ucs2'), u.indexOf('\u6300', 'ucs2'), u.indexOf('c', 3, 'ucs2'), u.lastIndexOf('b', 3, 'ucs2'), u.indexOf(Buffer.from([0, 0x63]), 0, 'ucs2')]);
t('hex search', () => [b.indexOf('6263', 'hex'), b.indexOf('YmM=', 'base64')]);
// fill with a pattern across lengths (written once, then doubled), the class's name
t('fill patterns', () => [1, 2, 3, 7, 8, 17].map((n) => [Buffer.alloc(n, 'abc').toString(), Buffer.alloc(n).fill('xy', 1, n).toString('hex'), Buffer.alloc(n, '€').toString('hex')]));
t('fill number / buffer', () => [Buffer.alloc(5, 0x101).toString('hex'), Buffer.alloc(5, Buffer.from([1, 2])).toString('hex'), Buffer.allocUnsafe(3).fill(7).toString('hex')]);
t('constructor name', () => [Buffer.name, Buffer.alloc(1).constructor.name, Buffer.allocUnsafe(1).constructor.name, Buffer.from('a').constructor.name]);
// Node refuses a string longer than kMaxLength before decoding (the buffer's pages are never touched)
{
  const big = Buffer.alloc(0x0ffffff5);
  t('too long hex', () => big.toString('hex'));
  t('hex of a part', () => big.toString('hex', 0, 3));
}
