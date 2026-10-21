const http = require('http');
const net = require('net');

function raw(port, text) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let out = '';
    socket.on('data', (d) => (out += d));
    socket.on('error', () => {});
    socket.on('close', () => resolve(out.replace(/Date: [^\r]*\r\n/, '')));
  });
}

const requests = [
  ['two lengths', 'POST /a HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nContent-Length: 5\r\n\r\nGET /next HTTP/1.1\r\nHost: x\r\n\r\n'],
  ['the same length twice', 'POST /b HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nhi'],
  ['a list as the length', 'POST /c HTTP/1.1\r\nHost: x\r\nContent-Length: 2, 2\r\n\r\nhi'],
  ['a length and chunked', 'POST /d HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\n\r\n'],
  ['repeated fields', 'GET /e HTTP/1.1\r\nHost: x\r\nX-A: 1\r\nX-A: 2\r\nCookie: a=1\r\nCookie: b=2\r\nSet-Cookie: s=1\r\nSet-Cookie: t=2\r\nContent-Type: a\r\nContent-Type: b\r\nConnection: close\r\n\r\n'],
];

const responses = [
  ['two lengths', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nabc'],
  ['the same length twice', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nab'],
  ['a length and chunked', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r\n0\r\n\r\n'],
  ['repeated fields', 'HTTP/1.1 200 OK\r\nX-A: 1\r\nX-A: 2\r\nSet-Cookie: s=1\r\nSet-Cookie: t=2\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'],
];

async function server(withListener) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      console.log(`  handler ${req.method} ${req.url} ${JSON.stringify(body)} ${JSON.stringify(req.headers)}`);
      res.end('ok');
    });
  });
  if (withListener) {
    srv.on('clientError', (err, socket) => {
      console.log(`  clientError ${err.code} ${err.message} ${err.reason}`);
      socket.end('HTTP/1.1 400 Bad Request\r\nX-Own: yes\r\nConnection: close\r\n\r\n');
    });
  }
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  for (const [name, text] of requests) {
    console.log(`server${withListener ? ' with clientError' : ''}: ${name}`);
    console.log(`  wire ${JSON.stringify(await raw(srv.address().port, text))}`);
  }
  await new Promise((r) => srv.close(r));
}

async function client() {
  for (const [name, text] of responses) {
    const fake = net.createServer((s) => s.once('data', () => s.end(text)));
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: fake.address().port, agent: false }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          console.log(`client: ${name}: ${res.statusCode} ${JSON.stringify(body)} ${JSON.stringify(res.headers)}`);
          resolve();
        });
      });
      req.on('error', (err) => {
        console.log(`client: ${name}: error ${err.code} ${err.message} ${err.reason}`);
        req.on('close', resolve);
      });
    });
    await new Promise((r) => fake.close(r));
  }
}

(async () => {
  await server(false);
  await server(true);
  await client();
})();
