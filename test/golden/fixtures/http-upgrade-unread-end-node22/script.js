const http = require('http');
const UP = 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n';
const OK = 'HTTP/1.1 200 Connection Established\r\n\r\n';
const watch = (sock, log) => {
  sock.on('end', () => log.push('end'));
  return new Promise((resolve) => sock.on('close', () => { log.push('close'); resolve(); }));
};
let serverSide;
const srv = http.createServer((req, res) => res.end('request'));
const answer = (reply) => (req, sock) => {
  const log = [];
  const closed = watch(sock, log);
  if (/^\/?unread\b/.test(req.url)) sock.end(reply);
  else {
    sock.resume();
    sock.on('end', () => sock.end());
    sock.write(reply);
  }
  serverSide = closed.then(() => log.join(' '));
};
srv.on('upgrade', answer(UP));
srv.on('connect', answer(OK));
const request = (port, connect, path) =>
  new Promise((resolve) => {
    const opts = connect
      ? { host: '127.0.0.1', port, method: 'CONNECT', path: `${path.slice(1)}:1` }
      : { host: '127.0.0.1', port, path, headers: { Connection: 'Upgrade', Upgrade: 'x' } };
    const q = http.request(opts);
    q.on(connect ? 'connect' : 'upgrade', (res, sock, head) => {
      const log = [`${res.statusCode} head ${head.length}`];
      const closed = watch(sock, log);
      if (path === '/unread') {
        let got = '';
        sock.on('data', (d) => (got += d));
        sock.on('end', () => log.push(`read ${JSON.stringify(got)}`));
      } else sock.end();
      closed.then(() => serverSide).then((server) => resolve(`client: ${log.join(' ')}; server: ${server}`));
    });
    q.on('response', (res) => resolve(`response ${res.statusCode}`));
    q.on('error', (e) => resolve(`error ${e.code}`));
    q.end();
  });
srv.listen(0, '127.0.0.1', async () => {
  const { port } = srv.address();
  for (const connect of [false, true]) {
    for (const path of ['/unread', '/client-unread']) {
      console.log(connect ? 'connect' : 'upgrade', path, await request(port, connect, path));
    }
  }
  srv.close(() => console.log('close cb, listening', srv.listening));
});
