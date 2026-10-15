process.on('exit', (c) => console.log('exit listener 1 code', c, 'exitCode', process.exitCode));
process.on('exit', (c) => { console.log('exit listener 2'); process.exitCode = 9; });
process.exitCode = 2;
console.log('end of main');
