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
}
