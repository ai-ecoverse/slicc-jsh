// V8's frame names for anonymous functions and builtins: an arrow or a
// callback called with no receiver is its location alone, an anonymous
// function on a receiver is `Type.<anonymous>`, a builtin's frame is
// `(<anonymous>)`, a module's top level `Object.<anonymous>`. Node's own
// frames (node:internal/…) are left out: jsh has none.
const own = (stack) => stack.split('\n').filter((l) => !/\(node:|at node:/.test(l)).map((l) => l.replace(__dirname, 'DIR')).join('\n');
function named() {
  return [1].map(() => new Error('arrow in map').stack)[0];
}
console.log(own(named()));
const anon = function () {
  return new Error('function expression in map').stack;
};
console.log(own([1].map(anon)[0]));
console.log(own([1].map(function () {
  return new Error('anonymous function in map').stack;
})[0]));
console.log(own(JSON.parse('[1]', function (k, v) {
  return k === '0' ? new Error('reviver on its holder').stack : v;
})[0]));
console.log(own(new Error('top level').stack));
const obj = { m: [0].map(() => function () { return new Error('method of an object').stack; })[0] };
console.log(own(obj.m()));
console.log(own((() => new Error('called arrow').stack)()));
new Promise((resolve) => resolve()).then(() => {
  console.log(own(new Error('promise callback').stack));
});
setTimeout(() => console.log(own(new Error('timer callback').stack)), 0);
// The CallSites a prepareStackTrace sees: V8's getters (a label like
// `Array.<anonymous>` is the frame's string only; getFunctionName is null).
const sites = (fn) => {
  const prev = Error.prepareStackTrace;
  Error.prepareStackTrace = (e, s) => s;
  const s = fn();
  Error.prepareStackTrace = prev;
  return s;
};
const callSite = (label, s) =>
  console.log(label, JSON.stringify([s.getFunctionName(), s.getMethodName(), s.getTypeName(), s.isToplevel(), s.isAsync(), String(s).replace(__dirname, 'DIR')]));
callSite('CallSite of an arrow', [1].map(() => sites(() => new Error('x').stack)[2])[0]);
callSite('CallSite of a reviver', JSON.parse('[1]', function (k, v) {
  return k === '0' ? sites(() => new Error('j').stack)[2] : v;
})[0]);
const obj2 = { m: [0].map(() => function () { return sites(() => new Error('m').stack)[2]; })[0] };
callSite('CallSite of obj.m', obj2.m());
// Frames resumed after an await: `async …`, a location alone included.
async function a() {
  await null;
  throw new Error('in a');
}
async function b() {
  await a();
}
b().catch((e) => console.log(own(e.stack)));
(async () => {
  await null;
  await [0].map(async () => {
    await null;
    throw new Error('anonymous async callback');
  })[0];
})().catch((e) => console.log(own(e.stack)));
class K {
  async m() {
    await null;
    throw new Error('async method');
  }
}
(async () => {
  await new K().m();
})().catch((e) => console.log(own(e.stack)));
