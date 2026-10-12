process.on('beforeExit', () => console.log('beforeExit'));
console.log('before');
process.exitCode = 5;
await new Promise(() => {});
console.log('never');
