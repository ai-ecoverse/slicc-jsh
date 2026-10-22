const http = require('http');
const net = require('net');
const UP = 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n';
const late = (sock, head, done) => {
  let got = head.toString();
  setTimeout(() => {
    console.log('  readableFlowing before data', sock.readableFlowing);
    sock.on('data', (d) => (got += d));
    sock.on('end', () => done(got));
  }, 20);
};
const srv = http.createServer((req, res) => res.end('request'));
srv.on('upgrade', (req, sock, head) => {
  console.log('server upgrade', req.url, 'readableFlowing', sock.readableFlowing);
  if (req.url === '/server') {
    late(sock, head, (got) => {
      console.log('  server read', JSON.stringify(got));
      sock.end();
    });
    sock.write(UP);
  } else {
    sock.on('data', (d) => {
      if (String(d) === 'go') sock.end('after-go');
    });
    sock.write(UP);
  }
});
srv.listen(0, '127.0.0.1', async () => {
  const { port } = srv.address();
  await new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => c.write('GET /server HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n'));
    let out = '';
    c.on('data', (d) => {
      out += d;
      if (out === UP) c.end('after-101');
    });
    c.on('close', resolve);
  });
  await new Promise((resolve) => {
    const q = http.request({ host: '127.0.0.1', port, path: '/client', headers: { Connection: 'Upgrade', Upgrade: 'x' } });
    q.on('upgrade', (res, sock, head) => {
      console.log('client upgrade', res.statusCode, 'readableFlowing', sock.readableFlowing);
      sock.write('go');
      late(sock, head, (got) => {
        console.log('  client read', JSON.stringify(got));
        sock.on('close', resolve);
      });
    });
    q.end();
  });
  srv.close(() => console.log('closed'));
});
