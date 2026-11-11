import e from 'node:process';
try {
  for (let e = e; false; ) {}
  console.log('tdz-for-init', 'no-throw');
} catch (err) {
  console.log('tdz-for-init', err.name);
}
try {
  for (let y = e, e = 1; false; ) {}
  console.log('tdz-for-earlier', 'no-throw');
} catch (err) {
  console.log('tdz-for-earlier', err.name);
}
{
  const out = [];
  for (let y = () => e, e = 42; out.push(y()) && false; ) {}
  console.log('tdz-for-closure', out[0] === 42 ? 'inner' : 'import');
}
console.log('tdz-for-import', typeof e === 'object' ? 'import-ok' : 'import-bad');
