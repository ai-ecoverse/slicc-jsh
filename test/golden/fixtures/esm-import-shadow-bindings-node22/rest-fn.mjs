import e from 'node:process';
const k = (x) => (x === e ? 'IMPORT' : Array.isArray(x) ? 'arr' : typeof x);
function a(...e) {
  return k(e);
}
console.log('rest-fn', a(1));
