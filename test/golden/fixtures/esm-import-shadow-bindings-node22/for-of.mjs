import e from 'node:process';
const k = (x) => (x === e ? 'IMPORT' : Array.isArray(x) ? 'arr' : typeof x);
for (let e of ['rgb']) console.log('for-of', k(e));
