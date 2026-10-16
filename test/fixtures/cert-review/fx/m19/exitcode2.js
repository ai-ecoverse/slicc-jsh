process.exitCode = 3; process.on('exit', (c) => { console.log('listener sees', c, process.exitCode); process.exitCode = 9; });
