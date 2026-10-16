const net = require('net');
const srv = net.createServer(() => {}).listen(0, '127.0.0.1', () => console.log('listening'));
setTimeout(() => { console.log('unref timer fired'); process.exit(0); }, 300).unref();
setTimeout(() => { console.log('ref bail'); process.exit(3); }, 3000);
