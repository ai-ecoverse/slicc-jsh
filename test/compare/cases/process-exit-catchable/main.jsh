try {
  process.exit(3);
} catch (e) {
  console.log('caught', e && e.name, e && e.message);
} finally {
  console.log('finally ran');
}
console.log('after exit');
