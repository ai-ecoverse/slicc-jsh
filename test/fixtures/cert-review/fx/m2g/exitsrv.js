const srv = require('net').createServer().listen(0, '127.0.0.1', () => { console.log('listening, exit(4)'); process.exit(4); });
