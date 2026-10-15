process.on('exit', (c) => console.log('exit listener', c));
process.exitCode = 2; console.log('body done');
