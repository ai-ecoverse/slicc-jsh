const net = require('net');
const http = require('http');

const desc = Object.getOwnPropertyDescriptor(net.Server.prototype, 'listening');
console.log('listening getter', typeof desc.get, desc.set, desc.enumerable, desc.configurable);
console.log('own listening', Object.prototype.hasOwnProperty.call(net.createServer(), 'listening'));

const s = net.createServer();
console.log('new', s._handle, s.listening, s.address());
console.log('ref chains', s.ref() === s, s.unref() === s, s.ref() === s);
s.listen(0, '127.0.0.1', () => {
  console.log('listening', typeof s._handle, s._handle !== null, s.listening);
  const addr = s.address();
  console.log('address', Object.keys(addr), addr.address, addr.family, typeof addr.port);
  console.log('unref, ref', s.unref() === s, s.ref() === s);
  s.close(() => {
    console.log('closed', s._handle, s.listening, s.address());
    s.listen(0, '127.0.0.1', () => {
      console.log('listening again', typeof s._handle, s.listening, s.address() !== null);
      s.close(httpServer);
    });
  });
  console.log('right after close', s._handle, s.listening, s.address());
});
console.log('right after listen', s._handle, s.listening);
process.on('exit', (code) => console.log('exit', code));

function httpServer() {
  const h = http.createServer((req, res) => res.end('ok'));
  h.listen(0, '127.0.0.1', () => {
    console.log('http listening', typeof h._handle, h._handle !== null, h.listening);
    http.get(`http://127.0.0.1:${h.address().port}/`, (res) => {
      res.resume();
      res.on('end', () => {
        h.close(() => {
          console.log('http closed', h._handle, h.listening);
          const idle = net.createServer();
          idle.unref();
          idle.listen(0, '127.0.0.1', () => console.log('unref before listen: listening', idle.listening, typeof idle._handle));
        });
      });
    });
  });
}
