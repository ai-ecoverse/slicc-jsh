process.on('exit', (c) => { console.log('listener exits 4'); process.exit(4); });
throw new Error('boom-suppressed');
