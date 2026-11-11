import e from 'node:process';
const k = (x) => (x === e ? 'IMPORT' : Array.isArray(x) ? 'arr' : typeof x);
const f = (...e) => k(e);
console.log('rest-arrow', f(1));
