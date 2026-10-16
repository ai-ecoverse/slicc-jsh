process.on('exit', (c) => { console.log('first listener', c); });
process.on('exit', () => { console.log('second listener calls exit(12)'); process.exit(12); });
process.on('exit', () => { console.log('third listener'); });
process.exit(1);
