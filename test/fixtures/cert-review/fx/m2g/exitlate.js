const net = require('net');
const srv = net.createServer((s) => { s.write('hello'); s.end(); });
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1');
  c.on('data', () => {}); c.on('close', () => { console.log('client close'); setTimeout(() => { console.log('exit'); process.exit(0); }, 100); });
});
setTimeout(() => { console.log('bail'); process.exit(3); }, 2000);
