import e from 'node:process';
function f() {
  try {
    var e = 3;
  } catch {}
  return e;
}
const k = (x) => (x === e ? 'IMPORT' : x);
console.log('try-var', k(f()));
