// A request on a kept-alive socket the server has just closed (#361): Node's
// 'error' is ECONNRESET with reusedSocket true, the pair its retry idiom
// checks, whatever the kernel said about the write. On Linux the FIN's EOF
// is read before the reset, so it is 'socket hang up' with no syscall; macOS
// reports the reset first, as 'read ECONNRESET'.
const http = require('http');
const server = http.createServer((req, res) => res.end('ok'));
server.listen(0, '127.0.0.1', () => {
  const agent = new http.Agent({ keepAlive: true });
  const port = server.address().port;
  http.get({ host: '127.0.0.1', port, path: '/1', agent }, (res) => {
    res.resume();
    res.on('end', () => {
      setImmediate(() => {
        console.log('free before', Object.values(agent.freeSockets).flat().length);
        server.closeIdleConnections();
        const req = http.get({ host: '127.0.0.1', port, path: '/2', agent }, () => console.log('a response'));
        req.on('error', (e) => {
          console.log('error', e.code, e.message, e.syscall, 'reused', req.reusedSocket);
          agent.destroy();
          server.close(() => console.log('closed'));
        });
      });
    });
  });
});
