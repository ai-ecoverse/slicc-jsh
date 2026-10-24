const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const https = require('https');

const read = (name) => fs.readFileSync(path.join(__dirname, 'keys', name), 'utf8');
const own = { key: read('server.key'), cert: read('server.crt') };

const shown = (e) => {
  const message = e.message
    .replace(/\b[0-9A-F]{16}:error:/, 'error:')
    .replace(/:\.\.\/deps\/openssl\/[^:]*:\d+:\n$/, '')
    .replace(/:\.\.\/deps\/openssl\/[^:]*:\d+:/, ':')
    .replace(/\n$/, '');
  const errno = e.errno === undefined ? 'none' : e.errno === -os.constants.errno[e.code] ? `-${e.code}` : e.errno;
  return [
    `error ${e.code}, syscall ${e.syscall}, errno ${errno}`,
    `  message ${JSON.stringify(message)}`,
    `  library ${e.library}, reason ${e.reason}, own keys ${Object.keys(e).sort().join(' ')}`,
  ];
};

const servers = {
  plain: () =>
    net.createServer((c) => {
      c.on('error', () => {});
      c.resume();
      c.end('nope\n');
    }),
  closes: () =>
    net.createServer((c) => {
      c.on('error', () => {});
      c.once('data', () => c.end());
    }),
  alpn: () => tls.createServer({ ...own, ALPNProtocols: ['h2'] }).on('tlsClientError', () => {}),
  own: () => tls.createServer(own).on('tlsClientError', () => {}),
};

function row(label, server, client) {
  return new Promise((resolve) => {
    const ev = [];
    const srv = servers[server]();
    srv.listen(0, '127.0.0.1', () => {
      const t = client(srv.address().port);
      t.on('error', (e) => ev.push(...shown(e)));
      t.on('close', () => {
        ev.push('close');
        srv.close(() => {
          console.log(label);
          for (const e of ev) console.log(`  ${e}`);
          resolve();
        });
      });
    });
  });
}

const connect = (port, extra = {}) => tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false, ...extra });
const writing = (t) => {
  t.write('x');
  return t;
};

(async () => {
  await row('a plain-text reply, nothing written', 'plain', (p) => connect(p));
  await row('a plain-text reply, written before the handshake', 'plain', (p) => writing(connect(p)));
  await row('a plain-text reply, ended before the handshake', 'plain', (p) => {
    const t = connect(p);
    t.end('x');
    return t;
  });
  await row('a plain-text reply over a socket, written before the handshake', 'plain', (p) =>
    writing(tls.connect({ socket: net.connect(p, '127.0.0.1'), rejectUnauthorized: false }))
  );
  await row('no ALPN protocol in common, written before the handshake', 'alpn', (p) => writing(connect(p, { ALPNProtocols: ['http/1.1'] })));
  await row('a server that closes during the handshake, written before it', 'closes', (p) => writing(connect(p)));
  await row('a self-signed certificate refused, written before the handshake', 'own', (p) => writing(connect(p, { rejectUnauthorized: true })));
  await row('https.get to a plain-text server', 'plain', (p) => https.get({ host: '127.0.0.1', port: p, rejectUnauthorized: false, agent: false }));
  await row('https.request not yet ended, to a plain-text server', 'plain', (p) =>
    https.request({ host: '127.0.0.1', port: p, rejectUnauthorized: false, agent: false, method: 'POST' })
  );
  console.log('done');
})();
