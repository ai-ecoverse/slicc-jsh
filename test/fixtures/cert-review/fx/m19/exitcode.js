process.on('exit', (code) => { console.log('exit listener got', code); process.exitCode = 7; });
console.log('main');
