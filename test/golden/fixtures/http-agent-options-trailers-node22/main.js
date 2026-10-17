// The options an agent gets, and a response's trailers, over the kernel's loopback.
const http = require('http');

class Seeing extends http.Agent {
  createConnection(options, cb) {
    console.log('createConnection', JSON.stringify([options.x, options.servername, options.headers, options.method]));
    return super.createConnection(options, cb);
  }
}

// A chunked response with trailers, written as bytes (the client's side is the subject).
const net = require('net');
const server = net.createServer((sock) => {
  let head = '';
  sock.on('data', (d) => {
    head += d;
    if (!head.includes('\r\n\r\n')) return;
    const path = head.split(' ')[1];
    head = '';
    if (path === '/trailers') {
      sock.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTrailer: X-Checksum, X-More\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n1\r\nb\r\n0\r\nX-Checksum: abc\r\nX-More: 1\r\nx-more: 2\r\n\r\n');
    } else {
      sock.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nplain\r\n0\r\n\r\n');
    }
  });
});

const get = (path, options) =>
  new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, ...options }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        console.log(path, res.statusCode, JSON.stringify(body), JSON.stringify(res.rawTrailers), JSON.stringify(res.trailers));
        resolve();
      });
    });
    req.on('error', (e) => {
      console.log(path, 'error', e.code, e.message);
      resolve();
    });
    req.end();
  });

server.listen(0, '127.0.0.1', async () => {
  const agent = new Seeing();
  await get('/plain', { agent, x: 'mine', headers: { 'X-H': 'one' } });
  await get('/named', { agent, method: 'GET', headers: { Host: 'example.test:8080' } });
  await get('/ipv6', { agent, headers: { Host: '[::1]:8080' } });
  await get('/trailers', { agent });
  await get('/trailers', { agent: false });
  agent.destroy();
  server.close();
});
