import e from 'node:process';
function f() {
  for (var e in { a: 1 }) {}
  return e;
}
const k = (x) => (x === e ? 'IMPORT' : x);
console.log('for-in-var', k(f()));
