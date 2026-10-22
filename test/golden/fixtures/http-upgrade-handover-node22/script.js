const http = require('http');
const net = require('net');
const s = http.createServer((req, res) => res.end('request'));
s.on('clientError', (err) => console.log('clientError', err.message));
s.on('upgrade', (req, socket) => {
  console.log('at upgrade: error listeners', socket.listenerCount('error'));
  socket.on('error', (err) => console.log('the program sees', err.message));
  socket.emit('error', new Error('boom'));
  socket.on('data', () => {});
  setTimeout(() => socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\nlate'), 20);
});
s.listen(0, '127.0.0.1', () => {
  const c = net.connect(s.address().port, '127.0.0.1', () => c.end('GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n'));
  let out = '';
  c.on('data', (d) => (out += d));
  c.on('close', () => {
    console.log('after a FIN right after the head:', JSON.stringify(out));
    s.close();
  });
});
