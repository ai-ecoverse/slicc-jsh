import e from 'node:process';
const out = [];
for (let e of [1, 2]) out.push(() => e);
console.log(
  'closure-loop',
  out.map((f) => f()).join(','),
  typeof e === 'object' ? 'import-ok' : 'import-bad',
);
