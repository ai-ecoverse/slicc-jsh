// A server closed before it is listening gives its address back at once, as
// in Node 22 (#681): another listen() on the port right after works, and the
// closed one never says 'listening'. And one that listen()ed twice before
// either was done gives both ports back.
const net = require('net');
const getPort = () =>
  new Promise((resolve) => {
    const t = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = t.address();
      t.close(() => resolve(port));
    });
  });
const tryListen = (label, port) =>
  new Promise((resolve) => {
    const t = net.createServer().listen(port, '127.0.0.1', () => {
      console.log('another server listens on', label);
      t.close(resolve);
    });
    t.on('error', (e) => {
      console.log('another server cannot listen on', label + ':', e.code);
      resolve();
    });
  });
(async () => {
  const port = await getPort();
  const a = net.createServer().listen(port, '127.0.0.1');
  a.on('listening', () => console.log('the closed server is listening'));
  a.close(() => console.log('the closed server: close'));
  await tryListen('its port', port);

  const p1 = await getPort();
  const p2 = await getPort();
  const s = net.createServer();
  s.on('error', (e) => console.log('the twice-listened server:', e.code));
  s.listen(p1, '127.0.0.1');
  s.listen(p2, '127.0.0.1');
  s.close(() => console.log('the twice-listened server: close'));
  await tryListen('its first port', p1);
  await tryListen('its second port', p2);
})();
process.on('exit', () => console.log('the program ends'));
