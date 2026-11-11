import e from 'node:process';
function f() {
  if (true) {
    var e = 2;
  }
  return e;
}
const k = (x) => (x === e ? 'IMPORT' : x);
console.log('if-var', k(f()));
