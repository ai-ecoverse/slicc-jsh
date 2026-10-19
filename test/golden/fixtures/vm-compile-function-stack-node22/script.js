// vm.compileFunction's filename (and lineOffset) name the function's frames,
// with the code's own lines, as in Node: jest 30 compiles every test file
// this way, and its failures' frames and source frames come from them.
const vm = require('vm');
const top = (stack) => stack.split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 2).map((l) => l.trim().replace(/\(.*[\\/](script\.js)/, '($1')).join(' <- ');
const body = 'x = x + 1;\nconst e = new Error("boom");\nreturn [x, e.stack];\n';
const cases = [
  ['plain', {}],
  ['filename', { filename: '/proj/a.test.js' }],
  ['lineOffset', { filename: '/proj/b.test.js', lineOffset: 10 }],
  ['parsingContext', { filename: '/proj/c.test.js', parsingContext: vm.createContext({}) }],
  ['both', { filename: '/proj/d.test.js', parsingContext: vm.createContext({}), lineOffset: 3 }],
];
for (const [label, options] of cases) {
  const fn = vm.compileFunction(body, ['x'], options);
  const [x, stack] = fn(1);
  console.log(label, x, fn.name || '(anonymous)', top(stack));
}
// A thrown error's frames, and an error from a nested function on line 1.
const thrower = vm.compileFunction('(() => { throw new TypeError("nested"); })();', [], { filename: '/proj/e.test.js' });
try {
  thrower();
} catch (e) {
  console.log('thrown', e.message, top(e.stack));
}
