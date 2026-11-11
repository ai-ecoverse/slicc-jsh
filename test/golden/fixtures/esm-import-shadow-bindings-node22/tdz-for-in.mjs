import e from 'node:process';
try {
  for (const e in e) console.log('ran', e);
  console.log('tdz-for-in', 'no-throw');
} catch (err) {
  console.log('tdz-for-in', err.name);
}
console.log('tdz-for-in-import', typeof e === 'object' ? 'import-ok' : 'import-bad');
