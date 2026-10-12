setTimeout(() => console.log('timer never runs'), 10);
try {
  console.log('working');
  process.exit(2);
} catch (e) {
  console.error('failed:', e.message);
  process.exit(1);
} finally {
  console.log('finally never runs');
}
console.log('after never runs');
