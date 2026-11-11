import e from 'node:process';
const k = (x) => (x === e ? 'IMPORT' : Array.isArray(x) ? 'arr' : typeof x);
for (const e in { a: 1 }) console.log('for-in', k(e));
