const net = require('net');
const tls = require('tls');
const https = require('https');

const shown = (err) => [err.code, err.library, err.reason ?? err.message].filter((v) => v !== undefined).join(' | ');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function report(name, s, c) {
  console.log(name);
  for (const line of s) console.log('  server', line);
  for (const line of c) console.log('  client', line);
}

(async () => {
  {
    const s = [];
    const c = [];
    const server = tls.createServer(() => s.push('secureConnection'));
    server.on('tlsClientError', (err, socket) => s.push(`tlsClientError ${shown(err)}, destroyed ${socket.destroyed}`));
    const port = await listen(server);
    await new Promise((resolve) => {
      const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false });
      socket.on('secureConnect', () => c.push('secureConnect'));
      socket.on('error', (err) => c.push(`error ${shown(err)}`));
      socket.on('close', resolve);
    });
    server.close();
    report('tls.Server, a client that says hello', s, c);
  }

  {
    const s = [];
    const c = [];
    const server = https.createServer(() => s.push('request'));
    server.on('tlsClientError', (err) => s.push(`tlsClientError ${shown(err)}`));
    const port = await listen(server);
    await new Promise((resolve) => {
      https
        .get({ host: '127.0.0.1', port, rejectUnauthorized: false, agent: false }, () => c.push('response'))
        .on('error', () => {
          c.push('error');
          resolve();
        });
    });
    server.close();
    report('https.Server, a client that says hello', s, c);
  }

  {
    const s = [];
    const c = [];
    const server = tls.createServer({ handshakeTimeout: 300 });
    server.on('tlsClientError', (err, socket) => {
      s.push(`tlsClientError ${err.code}, destroyed ${socket.destroyed}`);
      socket.destroy();
    });
    const port = await listen(server);
    await new Promise((resolve) => {
      const raw = net.connect(port, '127.0.0.1');
      raw.on('end', () => c.push('end'));
      raw.on('close', resolve);
    });
    server.close();
    report('tls.Server, a client that stays silent', s, c);
  }
})();
