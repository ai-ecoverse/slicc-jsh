const cluster = require('cluster');
const net = require('net');
const name = process.argv[2];
const port = Number(process.env.PORT);
if (name === 'listen-then-disconnect') {
  net.createServer().listen(port, '127.0.0.1');
  cluster.worker.disconnect();
} else if (name === 'close-during-setup') {
  const s = net.createServer().listen(port, '127.0.0.1');
  s.close();
  setTimeout(() => cluster.worker.disconnect(), 100);
} else if (name === 'exclusive-relisten') {
  const s = net.createServer((sock) => {
    sock.destroy();
    process.send('a connection reaches address()', () => s.close(() => cluster.worker.disconnect()));
  });
  s.listen(0, '127.0.0.1', () => {
    s.close(() => {
      s.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
        net.connect(s.address().port, '127.0.0.1').on('error', (e) => {
          process.send(`connect to address() ${e.code}`, () => s.close(() => cluster.worker.disconnect()));
        });
      });
    });
  });
} else if (name === 'relisten-during-setup') {
  const s = net.createServer((sock) => {
    sock.destroy();
    process.send('a connection reaches address()', () => s.close(() => cluster.worker.disconnect()));
  });
  s.listen(0, '127.0.0.1');
  s.close();
  s.listen(0, '127.0.0.1', () => {
    net.connect(s.address().port, '127.0.0.1').on('error', (e) => {
      process.send(`connect to address() ${e.code}`, () => s.close(() => cluster.worker.disconnect()));
    });
  });
}
