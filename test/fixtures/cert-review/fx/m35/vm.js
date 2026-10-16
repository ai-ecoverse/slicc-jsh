const vm = require('vm');
const L = globalThis.L = (...a) => console.log(...a);
vm.runInThisContext('var a1 = 1; let b1 = 2; const c1 = 3; class D1 {}; function f1() { return 4 }');
vm.runInThisContext('L(a1, b1, c1, typeof D1, f1())');
L(typeof globalThis.a1, typeof globalThis.b1, typeof globalThis.D1, 'f1' in globalThis);
try { vm.runInThisContext('nope_x'); } catch (e) { L(e.name, e.message); }
const ctx = vm.createContext({ x: 1, L });
vm.runInContext('var y = x + 1; let z = 5; const w = 6; class K {}; function g() { return 7 }; L(typeof Array, typeof Object, y)', ctx);
vm.runInContext('L(z, w, typeof K, g(), y)', ctx);
L(ctx.y, ctx.z, ctx.w, typeof ctx.g, Object.keys(ctx).sort().join(','));
ctx.Array = 'shadow'; vm.runInContext('L(Array, typeof Math.max)', ctx);
try { vm.runInContext('nope_y', ctx); } catch (e) { L(e.name, e.message); }
L(vm.runInContext('typeof process + " " + typeof require + " " + typeof setTimeout + " " + typeof console', vm.createContext({ L })));
L(vm.runInNewContext('this.q = 1; typeof globalThis + " " + (globalThis === this)', {}));
L(vm.runInNewContext('a + b', { a: 1, b: 2 }), vm.isContext(ctx), vm.isContext({}));
const s = new vm.Script('n = (typeof n === "number" ? n : 0) + 1', { filename: 'count.vm' });
const c2 = vm.createContext({}); s.runInContext(c2); s.runInContext(c2); L('count', c2.n);
for (const src of ['let = = 1', 'function (', '1 +', 'return 5', 'a b', '}', '"unterminated', 'let x; let x;', 'await 1']) {
  try { new vm.Script(src, { filename: 'bad.js' }); L('compiled', src); } catch (e) { L(JSON.stringify(src), e.name, e.message); }
}
try { new vm.Script('x +', { filename: 'arrow.js' }); } catch (e) { L(e.stack.split('\n').slice(0, 4).join(' | ')); }
try { vm.runInThisContext('\n\nthrow new Error("boom")', { filename: 't.vm' }); } catch (e) { L(e.stack.split('\n')[1].trim()); }
try { vm.runInThisContext('(function inner() { throw new TypeError("deep") })()', { filename: 'deep.vm', lineOffset: 10 }); } catch (e) { L(e.stack.split('\n').slice(0, 3).map((x) => x.trim()).join(' | ')); }
const fn = vm.compileFunction('return a + x', ['a'], { parsingContext: ctx }); L('compileFunction', fn(10));
L(typeof vm.Script, typeof vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER, typeof vm.runInContext, typeof vm.measureMemory);
(async () => {
  const r = await new vm.Script('import("node:path").then((m) => typeof m.join)', { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }).runInThisContext();
  L('main loader', r);
  try { await new vm.Script('import("node:path")').runInThisContext(); L('no callback: resolved'); } catch (e) { L('no callback', e.code); }
  try { L('callback', await new vm.Script('import("node:os").then((m) => typeof m.platform)', { importModuleDynamically: (spec) => import(spec) }).runInThisContext()); } catch (e) { L('callback', e.code); }
  L('ctx loader', await vm.runInContext('import("node:url").then((m) => typeof m.URL)', vm.createContext({}), { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }));
})();
