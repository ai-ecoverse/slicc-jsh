import e from 'node:process';
function f() {
  for (var e = 0; e < 1; e++) {}
  return e;
}
const k = (x) => (x === e ? 'IMPORT' : x);
console.log('for-var', k(f()));
