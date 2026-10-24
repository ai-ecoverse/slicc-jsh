const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const https = require('https');

const read = (name) => fs.readFileSync(path.join(__dirname, 'keys', name), 'utf8');
const own = { key: read('server.key'), cert: read('server.crt') };

const row = (label, server, act) =>
  new Promise((resolve) => {
    server.on('tlsClientError', (e, socket) => {
      const errno = e.errno === undefined ? 'none' : e.errno === -os.constants.errno[e.code] ? `-${e.code}` : e.errno;
      console.log(`${label} | tlsClientError ${e.code} ${JSON.stringify(e.message)}, syscall ${e.syscall}, errno ${errno}, own keys ${Object.keys(e).sort().join(' ')}, destroyed ${socket.destroyed}`);
      server.close(resolve);
    });
    server.listen(0, '127.0.0.1', () => {
      const c = net.connect(server.address().port, '127.0.0.1', () => act(c));
      c.on('error', () => {});
    });
  });

(async () => {
  await row('tls.Server, the client resets before its hello', tls.createServer(own), (c) => c.resetAndDestroy());
  await row('tls.Server, the client resets after part of its hello', tls.createServer(own), (c) => {
    c.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x64, 0x01]));
    setTimeout(() => c.resetAndDestroy(), 50);
  });
  await row('https.Server, the client resets before its hello', https.createServer(own), (c) => c.resetAndDestroy());
  await row('tls.Server, the client closes before its hello', tls.createServer(own), (c) => c.destroy());
  await row('tls.Server, the client closes after part of its hello', tls.createServer(own), (c) => {
    c.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x64, 0x01]));
    setTimeout(() => c.destroy(), 50);
  });
  console.log('done');
})();
