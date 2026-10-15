const srv = require('http').createServer().listen(0, '127.0.0.1', () => { console.log('listening'); setTimeout(() => { console.log('exit(5)'); process.exit(5); }, 50); });
