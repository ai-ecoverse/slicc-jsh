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
