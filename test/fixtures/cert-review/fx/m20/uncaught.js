process.on('exit', (c) => console.log('exit listener before report?', c));
setTimeout(() => { throw new Error('late boom'); }, 1);
