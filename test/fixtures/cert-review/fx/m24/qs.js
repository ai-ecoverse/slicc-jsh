const qs = require('querystring');
const P = (l, f) => { try { console.log(l, JSON.stringify(f())); } catch (e) { console.log(l, 'throws', e.code, e.message); } };
P('parse', () => [qs.parse('a=1&b=2&a=3&c&d=&e=%20x+y&%zz=1&f=%E9'), qs.parse('a:1;b:2', ';', ':'), qs.parse('a=1&a=2&a=3', null, null, { maxKeys: 2 })]);
P('stringify', () => [qs.stringify({ a: [1, 2], b: 'x y', c: '', d: null, e: undefined, f: true, g: 'é€', h: { x: 1 } }), qs.stringify({ a: 'b' }, ';', ':'), qs.stringify({ w: 'x' }, null, null, { encodeURIComponent: (s) => s.toUpperCase() })]);
P('escape/unescape', () => [qs.escape('a b&c/é'), qs.unescape('a%20b%zz'), qs.unescapeBuffer('%41%42').toString()]);
P('decode/encode alias', () => [qs.decode === qs.parse, qs.encode === qs.stringify]);
