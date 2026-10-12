const u = require('util');
const o = { [Symbol('s')]: 3, a: 'Symbol(x): y' };
console.log(u.format(o), '|', u.format('%s|%o|%O|%d|%i|%f|%j|%c|%%|%x', o, o, o, '42', 4.5, '1.5', o, 'css'), u.format('Symbol(a): b', new ArrayBuffer(2)));
console.log(u.format('%s', Object.create(null)), u.format('%s', { toString() { return 'custom'; } }), u.format('%s', [1, [2, [3]]]), u.format('%s', new Error('e')).split('\n')[0], u.format('%s %s', -0, 12345678901234567890n));
console.log(u.formatWithOptions({ colors: true }, '%s', { a: 1 }, { b: 2 }), u.format(), u.format(1, 'a', null));
try { u.formatWithOptions(1, 'x') } catch (e) { console.log(e.code) }
console.log(new Map([[1,'a'],['b',{c:2}]]), new Set([1,'x',[2]]), [1,,3], {['a-b']:1, 'ok':2, [Symbol('s')]:3}, new ArrayBuffer(4));
