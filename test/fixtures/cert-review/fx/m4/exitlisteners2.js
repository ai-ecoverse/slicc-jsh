process.on('exit', (c) => console.log('exit listener sees', c));
setTimeout(() => process.exit(7), 10);
