import e from 'node:process';
const k = (x) => (x === e ? 'IMPORT' : Array.isArray(x) ? 'arr' : typeof x);
for (let e = 0; e < 1; e++) console.log('for', k(e));
