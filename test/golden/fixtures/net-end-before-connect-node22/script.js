const net = require('net');

const server = net.createServer((sock) => {
  let got = '';
  sock.on('data', (d) => (got += d));
  sock.on('end', () => {
    console.log('server got', JSON.stringify(got), 'then end');
    sock.end();
  });
});
server.listen(0, () => {
  const events = [];
  const c = net.connect(server.address().port, '127.0.0.1');
  c.on('connect', () => events.push('connect'));
  c.on('finish', () => events.push('finish'));
  c.on('end', () => events.push('end'));
  c.on('close', () => {
    console.log('client', events.join(' '));
    server.close(() => console.log('server closed'));
  });
  c.resume();
  c.write('hello ');
  c.end('world');
  console.log('pending after end', c.pending, c.connecting);
});
