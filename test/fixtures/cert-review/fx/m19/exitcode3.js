process.on('exit', (c) => { console.log('listener', c); process.exitCode = 5; }); process.exit(2);
