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

// Node's checks of the options, and code that would close the function.
// (V8's message for code that closes the function depends on how it was
// compiled; that it is a SyntaxError, and that nothing ran, doesn't.)
const check = (label, run, nameOnly) => {
  try {
    const fn = run();
    console.log(label, 'compiled', JSON.stringify(fn()));
  } catch (e) {
    console.log(label, e.name, ...(nameOnly ? [] : [e.code, e.message]));
  }
};
check('filename type', () => vm.compileFunction('', [], { filename: 1 }));
check('lineOffset type', () => vm.compileFunction('', [], { lineOffset: '10' }));
check('lineOffset range', () => vm.compileFunction('', [], { lineOffset: 2147483648 }));
check('columnOffset type', () => vm.compileFunction('', [], { columnOffset: '1' }));
check('a line break in the filename', () => vm.compileFunction('', [], { filename: 'x\nreturn 42' }));
check('a body that closes the function', () => vm.compileFunction('}); globalThis.escaped = 1; ({', []), true);
check('in a context', () => vm.compileFunction('}); globalThis.escaped = 1; ({', [], { parsingContext: vm.createContext({}) }), true);
console.log('escaped', typeof globalThis.escaped);
