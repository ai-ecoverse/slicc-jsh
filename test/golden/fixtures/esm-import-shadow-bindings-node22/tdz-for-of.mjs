import e from 'node:process';
try {
  for (let e of e) console.log('ran', e);
  console.log('tdz-for-of', 'no-throw');
} catch (err) {
  console.log('tdz-for-of', err.name);
}
console.log('tdz-for-of-import', typeof e === 'object' ? 'import-ok' : 'import-bad');
