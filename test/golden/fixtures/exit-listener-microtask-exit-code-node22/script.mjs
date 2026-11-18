process.on('exit', (code) => {
  console.log('exit', code);
  queueMicrotask(() => {
    process.exitCode = 5;
    console.log('exitCode', process.exitCode);
  });
});
