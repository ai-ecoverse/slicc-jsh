const http = require('http'); const net = require('net');
let conns = 0;
const server = http.createServer((req, res) => { if (req.url === '/stream') { res.write('a'); setTimeout(() => res.end('b'), 10); return; } if (req.url === '/close') res.setHeader('Connection', 'close'); res.end('ok'); });
server.on('connection', () => conns++);
const raw = (text) => new Promise((resolve) => { const s = net.connect(server.address().port, '127.0.0.1', () => s.write(text)); let b = ''; s.on('data', (d) => (b += d)); const t = setTimeout(() => { s.destroy(); resolve(`OPEN: ${JSON.stringify(b.replace(/Date: .*\r\n/g, ''))}`); }, 300); s.on('close', () => { clearTimeout(t); resolve(`CLOSED: ${JSON.stringify(b.replace(/Date: .*\r\n/g, ''))}`); }); });
server.listen(0, '127.0.0.1', async () => {
  console.log('1.1', await raw('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
  console.log('1.1 close', await raw('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
  console.log('1.0', await raw('GET / HTTP/1.0\r\n\r\n'));
  console.log('1.0 ka', await raw('GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n'));
  console.log('stream', await raw('GET /stream HTTP/1.1\r\nHost: x\r\n\r\n'));
  console.log('stream 1.0', await raw('GET /stream HTTP/1.0\r\n\r\n'));
  console.log('res close', await raw('GET /close HTTP/1.1\r\nHost: x\r\n\r\n'));
  console.log('pipelined', await raw('GET /p1 HTTP/1.1\r\nHost: x\r\n\r\nGET /p2 HTTP/1.1\r\nHost: x\r\n\r\n'));
  console.log('upgrade no listener', await raw('GET /u HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n'));
  const s = net.connect(server.address().port, '127.0.0.1', () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
  s.once('data', () => { const t0 = Date.now(); server.close(() => console.log('server.close cb after', Date.now() - t0 < 1000 ? '<1s' : '>1s')); s.on('close', () => console.log('idle client socket closed by server.close')); });
});
