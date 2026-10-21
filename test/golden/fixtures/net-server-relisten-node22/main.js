const net = require('net');
const log = (...a) => console.log(...a);
const s = net.createServer();
s.on('close', () => log('close event, listening', s.listening));
s.listen(0, '127.0.0.1', () => {
  const c = net.connect(s.address().port, '127.0.0.1');
  s.once('connection', (sock) => {
    s.close(() => log('close callback 1'));
    log('closed with a connection open, listening', s.listening);
    s.listen(0, '127.0.0.1', () => {
      log('listening again', s.listening);
      sock.on('close', () => {
        setImmediate(() => {
          log('old connection gone, listening', s.listening);
          s.close(() => log('close callback 2'));
        });
      });
      c.end();
    });
  });
});
