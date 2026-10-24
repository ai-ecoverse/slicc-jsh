const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const https = require('https');

const read = (name) => fs.readFileSync(path.join(__dirname, 'keys', name), 'utf8');
const key = read('server.key');
const cert = read('server.crt');
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const plainHttp = (label, server) =>
  new Promise((resolve) => {
    const ev = [];
    server.on('tlsClientError', (err, socket) => {
      const message = err.message.replace(/^[0-9A-F]+:error:/, 'error:').replace(/:[^:]*:\d+:\n$/, '');
      ev.push(`tlsClientError ${err.code} ${JSON.stringify(message)} (${err.library}, ${err.reason}), destroyed ${socket.destroyed}`);
    });
    listen(server).then((port) => {
      const c = net.connect(port, '127.0.0.1');
      let got = '';
      c.on('connect', () => c.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
      c.on('data', (d) => (got += d));
      c.on('error', (e) => ev.push(`client error ${e.code}`));
      c.on('close', () =>
        server.close(() => {
          console.log(`${label} | ${ev.join(', ')} | client got ${got.length} bytes`);
          resolve();
        })
      );
    });
  });

const silent = (label, server) =>
  new Promise((resolve) => {
    const ev = [];
    let client;
    let ended = false;
    server.on('tlsClientError', (err, socket) => {
      ev.push(`tlsClientError ${err.code}, destroyed ${socket.destroyed}`);
      setTimeout(() => {
        ev.push(`200 ms later the client's side is ${ended ? 'ended' : 'open'}`);
        socket.destroy();
      }, 200);
    });
    listen(server).then((port) => {
      client = net.connect(port, '127.0.0.1');
      client.on('end', () => (ended = true));
      client.on('error', (e) => ev.push(`client error ${e.code}`));
      client.on('close', () =>
        server.close(() => {
          console.log(`${label} | ${ev.join(', ')} | client closed`);
          resolve();
        })
      );
    });
  });

(async () => {
  await plainHttp('tls.Server, a plain HTTP request', tls.createServer({ key, cert }, () => {}));
  await plainHttp('https.Server, a plain HTTP request', https.createServer({ key, cert }, () => {}));
  await silent('tls.Server, handshakeTimeout, a client that never says hello', tls.createServer({ key, cert, handshakeTimeout: 300 }, () => {}));
  console.log('done');
})();
