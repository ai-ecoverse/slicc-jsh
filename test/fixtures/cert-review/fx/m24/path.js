const path = require('path');
const P = (l, f) => { try { console.log(l, JSON.stringify(f())); } catch (e) { console.log(l, 'throws', e.code, e.message); } };
for (const [n, p] of [['posix', path.posix], ['win32', path.win32]]) {
  P(`${n} join`, () => p.join('a', '..', 'b', './c', '/d', ''));
  P(`${n} resolve`, () => p.resolve('/x/y', '../z', 'w'));
  P(`${n} normalize`, () => [p.normalize('a//b/../c/./d/'), p.normalize('C:\\a\\..\\b'), p.normalize('\\\\server\\share\\x\\..')]);
  P(`${n} relative`, () => [p.relative('/a/b/c', '/a/d'), p.relative('C:\\a\\b', 'C:\\a\\c'), p.relative('C:\\a', 'D:\\b')]);
  P(`${n} parse`, () => [p.parse('/home/u/file.tar.gz'), p.parse('C:\\dir\\f.txt'), p.parse('\\\\srv\\sh\\x.y')]);
  P(`${n} format`, () => p.format({ root: '/', dir: '/a', base: 'b.c' }));
  P(`${n} isAbsolute`, () => ['/a', 'C:\\a', 'C:a', '\\\\s\\x', 'a'].map((x) => p.isAbsolute(x)));
  P(`${n} toNamespacedPath`, () => [p.toNamespacedPath('C:\\a\\b'), p.toNamespacedPath('\\\\srv\\share\\x'), p.toNamespacedPath('/a')]);
  P(`${n} ext/base/dir`, () => [p.extname('a.b.c'), p.extname('.bashrc'), p.basename('/a/b.txt', '.txt'), p.dirname('C:\\a\\b')]);
  P(`${n} sep/delimiter`, () => [p.sep, p.delimiter]);
}
P('same objects', () => [path === path.posix, path.win32 === require('path/win32'), path.posix === require('path/posix'), path.win32.win32 === path.win32]);
P('matchesGlob', () => [['a/b/c.js', 'a/**/*.js'], ['a/b/c.ts', 'a/**/*.js'], ['x.txt', '*.{txt,md}'], ['.hidden', '*'], ['a/b', 'a/?'], ['A/b', 'a/b']].map(([f, g]) => path.matchesGlob(f, g)));
P('win32 matchesGlob', () => path.win32.matchesGlob('a\\b\\c.js', 'a/**/*.js'));
P('bad args', () => path.join(null));
