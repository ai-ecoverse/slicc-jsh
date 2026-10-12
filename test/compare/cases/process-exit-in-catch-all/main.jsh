try {
  console.log('working');
  process.exit(2);
} catch (e) {
  console.error('failed:', e.message);
  process.exit(1);
}
