// Node 22's own lib/util.js and console (lib/internal/console), plus async_hooks' AsyncResource.
const util = require('util');
const { Writable } = require('stream');
const t = (label, f) => {
  try {
    const v = f();
    console.log(label, typeof v === 'string' ? v : util.inspect(v, { depth: 4, breakLength: 120 }));
  } catch (e) {
    console.log(label, 'THROWS', e.name, e.code, e.message.split('\n')[0]);
  }
};
t('keys', () => Object.keys(util).sort().join(' '));
t('types keys', () => Object.keys(util.types).sort().length);
t('parseArgs', () => util.parseArgs({ args: ['-f', '--bar', 'b', 'pos', '--no-color'], options: { foo: { type: 'boolean', short: 'f' }, bar: { type: 'string' }, color: { type: 'boolean' } }, allowPositionals: true, allowNegative: true, tokens: true }));
t('parseArgs unknown', () => util.parseArgs({ args: ['--nope'], options: {} }));
t('parseArgs positional', () => util.parseArgs({ args: ['x'], options: {} }));
t('parseArgs default', () => util.parseArgs({ args: [], options: { n: { type: 'string', default: 'd' }, m: { type: 'string', multiple: true, default: ['a'] } } }).values);
t('styleText', () => JSON.stringify([util.styleText('red', 'hi', { validateStream: false }), util.styleText(['bold', 'underline'], 'x', { validateStream: false }), util.styleText('none', 'n', { validateStream: false })]));
t('styleText bad', () => util.styleText('nocolor', 'x'));
t('styleText stream', () => util.styleText('red', 'plain', { stream: process.stdout }));
t('inspect.colors', () => Object.keys(util.inspect.colors).length > 30 && util.inspect.colors.red);
t('inspect.styles', () => util.inspect.styles.number);
t('stripVT', () => util.stripVTControlCharacters('\u001b[31mred\u001b[39m \u001b]8;;http://x\u0007link\u001b]8;;\u0007'));
t('toUSVString', () => JSON.stringify(util.toUSVString('a\ud800b')));
t('errors', () => [-1, -2, -9, -13, -22, -99999].map((n) => [util.getSystemErrorName(n), util.getSystemErrorMessage(n)]));
t('errors bad', () => util.getSystemErrorName(2));
t('errorMap', () => util.getSystemErrorMap().get(-2));
t('parseEnv', () => util.parseEnv('A=1\n# c\nB="x\\ny"\nexport C = 3 # tail\nD=\'q\'\nE\nF=`b`\n'));
t('MIMEType', () => { const m = new util.MIMEType('text/HTML; Charset="utf-8"; x=y'); return [m.type, m.subtype, m.essence, m.params.get('charset'), String(m), [...m.params.keys()]]; });
t('MIMEType bad', () => new util.MIMEType('/x'));
t('types', () => [util.types.isPromise(Promise.resolve()), util.types.isRegExp(/x/), util.types.isDate(new Date()), util.types.isMap(new Map()), util.types.isNativeError(new TypeError()), util.types.isNativeError({ __proto__: Error.prototype }), util.types.isBoxedPrimitive(Object(1)), util.types.isAsyncFunction(async () => {}), util.types.isGeneratorFunction(function* () {}), util.types.isArrayBuffer(new ArrayBuffer(1)), util.types.isUint8Array(Buffer.alloc(1)), util.types.isMapIterator(new Map().keys()), util.types.isArgumentsObject((function () { return arguments; })())]);
t('legacy', () => [util.isArray([]), util.isBoolean(true), util.isString(''), util._extend({ a: 1 }, { b: 2 })]);
t('callbackify', () => typeof util.callbackify(async () => 1));
t('isDeepStrictEqual', () => [util.isDeepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), util.isDeepStrictEqual([1], ['1']), util.isDeepStrictEqual(new Set([1]), new Set([1])), util.isDeepStrictEqual(NaN, NaN), util.isDeepStrictEqual(new Date(1), new Date(2))]);
t('diff', () => util.diff('abc', 'abd'));
t('transferable', () => typeof util.transferableAbortSignal(new AbortController().signal));
t('debuglog', () => [typeof util.debuglog('x'), util.debuglog('x').enabled]);
t('events spread', () => Object.keys({ ...require('events') }).sort().join(' '));
t('EventEmitterAsyncResource', () => { const E = require('events'); const x = new E.EventEmitterAsyncResource({ name: 'n' }); return [typeof x.asyncResource, x.asyncId > 1, x instanceof E]; });
t('async_hooks', () => { const ah = require('async_hooks'); const r = new ah.AsyncResource('X'); return [Object.keys(ah).sort().join(' '), ah.executionAsyncId(), r.runInAsyncScope(() => ah.executionAsyncId()) === r.asyncId(), r.runInAsyncScope((a, b) => a + b, null, 1, 2)]; });
// console
console.table([{ a: 1, b: 'x' }, { a: 2, c: true }]);
console.table(new Map([['k', { v: 1 }]]));
console.table([[1, 2], [3]], ['0']);
console.group('G');
console.log('in');
console.groupEnd();
console.count();
console.count();
console.countReset();
console.count();
console.dir({ a: { b: { c: { d: 1 } } } }, { depth: 1 });
console.assert(false, 'assert %s', 'msg');
console.log('%c styled', 'color:red');
let out = '';
const sink = new Writable({ write(c, e, cb) { out += c; cb(); } });
const c2 = new console.Console({ stdout: sink, stderr: sink, groupIndentation: 4 });
c2.group('h');
c2.log({ x: 1 });
c2.error('e');
console.log('Console instance', JSON.stringify(out));
t('console keys', () => Object.keys(console).sort().join(' '));
t('console bad', () => new console.Console({}));
