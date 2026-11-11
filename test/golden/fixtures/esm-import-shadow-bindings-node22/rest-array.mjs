import e from 'node:process';
const k = (x) => (x === e ? 'IMPORT' : Array.isArray(x) ? 'arr' : typeof x);
function d([...e]) {
  return k(e);
}
console.log('rest-array', d([1]));
