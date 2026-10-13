// vm, against host Node: scripts in the program's context (their top-level
// declarations seen by the next one), contexts (names on the context object,
// the ECMAScript globals through), V8's SyntaxError with its arrow, frames
// named by the script's filename, import() without a callback.
const vm = require('vm');
const t = (l, f) => {
  try {
    console.log(l, JSON.stringify(f()));
  } catch (e) {
    console.log(l, 'THROWS', e.name, e.code, e.message);
  }
};
t('declarations persist', () => {
  vm.runInThisContext('let a1 = 1; const b1 = 2; class C1 {}; function f1() { return a1 + b1 }; var v1 = 4');
  return vm.runInThisContext('[f1(), typeof C1, v1, globalThis.v1, typeof globalThis.f1]');
});
t('completion value', () => [vm.runInThisContext('1; 2'), vm.runInThisContext('if (true) { "x" }'), vm.runInThisContext('')]);
t('Script reuse', () => { const s = new vm.Script('globalThis.n1 = (globalThis.n1 || 0) + 1'); s.runInThisContext(); return s.runInThisContext(); });
t('context', () => {
  const ctx = vm.createContext({ x: 2 });
  const r = vm.runInContext('var y = x * 3; function g() { return y + 1 } z = g(); typeof Object + typeof process', ctx);
  return [r, ctx.y, ctx.z, typeof ctx.g, vm.isContext(ctx), vm.isContext({})];
});
t('runInNewContext', () => vm.runInNewContext('a + b', { a: 1, b: 2 }));
t('isContext bad arg', () => vm.isContext(1));
t('runInContext not a context', () => vm.runInContext('1', {}));
for (const [code, name] of [['foo bar', 's1.vm'], ['let = ;', 's2.vm'], ['return 1', 's3.vm'], ['\n\n  (1 + ', 's4.vm']]) {
  try {
    new vm.Script(code, { filename: name });
  } catch (e) {
    console.log(name, e.name, e.message, JSON.stringify(e.stack.split('\n').slice(0, 4)));
  }
}
try {
  vm.runInThisContext('\n(() => {\n  throw new Error("x")\n})()', { filename: 'f.vm' });
} catch (e) {
  console.log('frames', JSON.stringify(e.stack.split('\n').slice(0, 7)));
}
try {
  vm.runInThisContext('throw new TypeError("quiet")', { filename: 'q.vm', displayErrors: false });
} catch (e) {
  console.log('displayErrors false', JSON.stringify(e.stack.split('\n').slice(0, 2)));
}
try {
  vm.runInThisContext('function named() { throw new Error("n") }\nnamed()', { filename: 'n.vm' });
} catch (e) {
  console.log('named frames', JSON.stringify(e.stack.split('\n').filter((l) => /n\.vm/.test(l))));
}
vm.runInThisContext('import("node:path")').then(
  () => console.log('import resolved'),
  (e) => console.log('import', e.name, e.code, e.message)
);
vm.runInThisContext('import("node:path")', { importModuleDynamically: (spec) => ({ custom: spec }) }).then(
  (m) => console.log('import callback', JSON.stringify(m)),
  (e) => console.log('import callback', e.name, e.code, e.message)
);
console.log(Object.keys(vm).sort().join(' '));
