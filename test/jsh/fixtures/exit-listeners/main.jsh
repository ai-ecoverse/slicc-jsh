process.on('exit', (code) => console.log('exit listener', code, process.exitCode));
try {
  process.exit(3);
} catch {
  process.exitCode = 9;
  console.log('catch never runs');
}
