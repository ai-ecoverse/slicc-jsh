// A vm context's own global (#281; the cert review's m38/chprobe.js): its
// top-level `this` and `globalThis` are the context's global, not the
// sandbox object, with the sandbox's properties and the ECMAScript builtins
// on it. (Not pinned here, as jsh has one realm: the builtins' identity, and
// a sloppy function's `this`, which V8 makes the context's global.)
const vm = require('vm');
const ctx = vm.createContext({ a: 1 });
const g = vm.runInContext('this', ctx);
console.log('this is the sandbox', g === ctx, 'globalThis is this', vm.runInContext('globalThis === this', ctx));
console.log('builtins on it', ['Atomics', 'SharedArrayBuffer', 'Array', 'Object', 'JSON', 'console', 'setTimeout', 'process'].map((n) => `${n}:${typeof g[n]}`).join(' '));
console.log("'Atomics' in it", 'Atomics' in g, "'a' in it", 'a' in g, 'keys', JSON.stringify(Object.keys(g)));
console.log('a through it', g.a, vm.runInContext('this.a + globalThis.a', ctx));
vm.runInContext('this.x = 5; globalThis.y = 6; var z = 7;', ctx);
console.log('writes land on the sandbox', ctx.x, ctx.y, ctx.z, JSON.stringify(Object.keys(ctx)));
g.w = 8;
console.log('a write through it from outside', ctx.w, vm.runInContext('w', ctx));
console.log('runInNewContext this', vm.runInNewContext('typeof this.Math + " " + (this.b === 2)', { b: 2 }));
