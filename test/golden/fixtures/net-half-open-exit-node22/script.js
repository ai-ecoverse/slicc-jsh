const net = require('net');
const s = net.createServer({ allowHalfOpen: true }, (sock) => {
  sock.on('end', () => {
    console.log('server: the client ended, the socket stays writable', sock.writable);
    s.close(() => console.log('server closed'));
  });
  sock.resume();
});
s.listen(0, '127.0.0.1', () => net.connect(s.address().port, '127.0.0.1', function () { this.end('bye', () => this.destroy()); }));
process.on('exit', (code) => console.log('exit', code));
