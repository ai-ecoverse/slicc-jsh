// A server closed before it is listening gives its address back at once, as
// in Node 22 (#681): another listen() on the port right after works, and the
// closed one never says 'listening'.
const net = require('net');
const free = net.createServer().listen(0, '127.0.0.1', () => {
  const { port } = free.address();
  free.close(() => {
    const a = net.createServer().listen(port, '127.0.0.1');
    a.on('listening', () => console.log('the closed server is listening'));
    a.close(() => console.log('the closed server: close'));
    const b = net.createServer().listen(port, '127.0.0.1', () => {
      console.log('another server listens on its port');
      b.close(() => console.log('and closes'));
    });
    b.on('error', (e) => console.log('another server cannot listen:', e.code));
  });
});
process.on('exit', () => console.log('the program ends'));
