import e from 'node:process';
function f() {
  for (var e of [1]) {}
  return e;
}
const k = (x) => (x === e ? 'IMPORT' : x);
console.log('for-of-var', k(f()));
