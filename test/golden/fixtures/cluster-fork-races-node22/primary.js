const cluster = require('cluster');
const net = require('net');
const path = require('path');
const name = process.argv[2];
process.on('exit', () => console.log('primary ends'));
const getPort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
(async () => {
  cluster.setupPrimary({ exec: path.join(__dirname, 'worker.js'), args: [name] });
  const port = await getPort();
  const w = cluster.fork({ PORT: String(port) });
  w.on('exit', (code, signal) => {
    console.log(`worker exit ${code} ${signal}`);
    if (name !== 'close-during-setup') return;
    const s = net.createServer().listen(port, '127.0.0.1', () => {
      console.log('the primary listens on the port');
      s.close();
    });
    s.on('error', (e) => console.log('the primary cannot listen', e.code));
  });
})();
