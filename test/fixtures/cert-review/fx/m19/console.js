const util = require('util');
console.log(util.format('%s|%d|%i|%f|%j|%o|%O|%c|%%|%s', 'str', 42.5, 42.9, '3.5', { a: 1 }, [1, { b: 2 }], { c: { d: { e: { f: 1 } } } }, 'color:red', Symbol('s')));
console.log(util.format('%s', 1n, null, undefined, -0), util.format('%d', '0x10', -0), util.format(1, 2, '%s'), util.format('%s:%s', 'only'));
console.log(util.format('%s', { toString() { return 'custom'; } }), util.format('%s', new Error('e1').message), util.format('%s', [1, [2, [3, [4]]]]));
console.log(util.inspect({ a: 'x', n: 1, b: true, u: undefined, nl: null, s: Symbol('y'), f() {}, d: new Date(0), m: new Map([[1, 2]]), st: new Set([1]) }, { colors: true }));
console.log(util.inspect('str', { colors: true }), util.inspect(5, { colors: true }), util.inspect([1, 'a'], { colors: true }));
try { console.log(JSON.stringify(util.inspect.colors.red), JSON.stringify(util.inspect.styles.number)); } catch (e) { console.log('inspect.colors/styles', e.name, typeof util.inspect.colors, typeof util.inspect.styles); }
try { console.log(util.stripVTControlCharacters(util.inspect({ x: 1 }, { colors: true }))); } catch (e) { console.log('stripVTControlCharacters', e.name); }
console.log(util.styleText ? util.styleText('red', 'hi').length : 'no styleText', util.styleText && JSON.stringify(util.styleText(['bold', 'underline'], 'x')));
console.trace('trace %s', 'msg');
console.table([{ a: 1, b: 'x' }, { a: 2, c: true }]);
console.dir({ deep: { a: { b: { c: { d: 1 } } } } }, { depth: 0 });
console.group('G'); console.log('inside'); console.groupEnd(); console.log('outside');
console.count(); console.count('x'); console.count(); console.countReset(); console.count();
console.assert(1 === 2, 'assert %s', 'msg');
