import { env as e } from 'node:process';
const k = (x) => (x === e ? 'IMPORT' : Array.isArray(x) ? 'arr' : typeof x);
for (let e of ['rgb']) console.log('named-for-of', k(e));
function a(...e) {
  return k(e);
}
console.log('named-rest', a(1));
