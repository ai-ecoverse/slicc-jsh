const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const https = require('https');
const express = require('express');

const read = (name) => fs.readFileSync(path.join(__dirname, 'keys', name), 'utf8');
const key = read('server.key');
const cert = read('server.crt');
const clientCa = read('ca.crt');
const good = { key: read('client.key'), cert: read('client.crt') };
const rogue = { key: read('rogue.key'), cert: read('rogue.crt') };

const shown = (err) => [err.code, err.library, err.reason ?? err.message].filter((v) => v !== undefined).join(' | ');
const peer = (socket) => {
  const c = socket.getPeerCertificate(true);
  if (!c || !c.subject) return 'none';
  return `${c.subject.CN} <- ${c.issuerCertificate?.subject?.CN}`;
};
const side = (socket) =>
  [
    `protocol ${socket.getProtocol()}`,
    `alpn ${socket.alpnProtocol}`,
    `servername ${socket.servername}`,
    `authorized ${socket.authorized}`,
    `authorizationError ${socket.authorizationError}`,
    `peer ${peer(socket)}`,
    `encrypted ${socket.encrypted}`,
  ].join(', ');

function report(name, server, client) {
  console.log(name);
  for (const line of server) console.log('  server', line);
  for (const line of client) console.log('  client', line);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function tlsCase(name, serverOptions, clientOptions, { clientErrors = true } = {}) {
  const s = [];
  const c = [];
  let served;
  const outcome = new Promise((resolve) => (served = resolve));
  const server = tls.createServer({ key, cert, ...serverOptions }, (socket) => {
    s.push(`secureConnection: ${side(socket)}`);
    socket.on('error', () => {});
    socket.on('close', served);
    socket.end('hello from tls');
  });
  server.on('tlsClientError', (err, socket) => {
    s.push(`tlsClientError ${shown(err)}, destroyed ${socket.destroyed}`);
    served();
  });
  const port = await listen(server);
  await new Promise((resolve) => {
    const socket = tls.connect({ host: 'localhost', port, servername: 'localhost', ca: cert, ...clientOptions });
    let data = '';
    socket.on('secureConnect', () => c.push(`secureConnect: authorized ${socket.authorized}, alpn ${socket.alpnProtocol}`));
    socket.on('data', (d) => (data += d));
    socket.on('error', (err) => {
      if (clientErrors) c.push(`error ${shown(err)}`);
    });
    socket.on('close', () => {
      c.push(`got ${JSON.stringify(data)}`);
      resolve();
    });
  });
  await outcome;
  await close(server);
  report(name, s, c);
}

function get(port, options = {}, pathname = '/x', refused = false) {
  return new Promise((resolve) => {
    const req = https.get(`https://localhost:${port}${pathname}`, { agent: false, ...options }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(`${res.statusCode} ${res.headers['content-type']} ${body}`));
    });
    req.on('error', (err) => resolve(refused ? 'no response' : `error ${shown(err)}`));
  });
}

async function httpsCase(name, serverOptions, requests) {
  const s = [];
  const c = [];
  const server = https.createServer({ key, cert, ...serverOptions }, (req, res) => {
    s.push(`request ${req.method} ${req.url}: ${side(req.socket)}`);
    res.setHeader('content-type', 'text/plain');
    res.end(`hello ${req.url}`);
  });
  const port = await listen(server);
  for (const [label, options, refused] of requests) c.push(`${label}: ${await get(port, options, `/${label}`, refused)}`);
  await close(server);
  report(name, s, c);
}

function throws(name, f) {
  try {
    f();
    console.log(name, 'no throw');
  } catch (err) {
    console.log(name, 'throws', err.code, err.message);
  }
}

(async () => {
  await httpsCase('https.get with the self-signed cert as ca', {}, [
    ['with-ca', { ca: cert }],
    ['without-ca', {}],
    ['unchecked', { rejectUnauthorized: false }],
  ]);

  await httpsCase('https with an encrypted key and its passphrase', { key: read('server-enc.key'), passphrase: 'sesame' }, [
    ['ok', { ca: cert }],
  ]);

  throws('tls.createServer, wrong passphrase', () => tls.createServer({ key: read('server-enc.key'), passphrase: 'wrong', cert }));
  throws('https.createServer, no passphrase', () => https.createServer({ key: read('server-enc.key'), cert }));
  throws('tls.createServer, key for another cert', () => tls.createServer({ key: rogue.key, cert }));

  const mtls = { ca: clientCa, requestCert: true };
  await tlsCase('mTLS, a client cert the ca issued', mtls, good);
  await tlsCase('mTLS, a self-signed client cert', mtls, rogue, { clientErrors: false });
  await tlsCase('mTLS, no client cert', mtls, {}, { clientErrors: false });
  await tlsCase('mTLS asked, not required, a self-signed client cert', { ...mtls, rejectUnauthorized: false }, rogue);
  await tlsCase('mTLS asked, not required, no client cert', { ...mtls, rejectUnauthorized: false }, {});
  await tlsCase('no client cert asked', {}, good);

  await httpsCase('https with requestCert: a rejected client never reaches the handler', mtls, [
    ['good', { ca: cert, ...good }],
    ['rogue', { ca: cert, ...rogue }, true],
    ['none', { ca: cert }, true],
  ]);

  await tlsCase('ALPN: the server preference the client offers', { ALPNProtocols: ['h2', 'http/1.1'] }, { ALPNProtocols: ['http/1.1', 'h2'] });
  await tlsCase('ALPN: nothing in common', { ALPNProtocols: ['h2'] }, { ALPNProtocols: ['x-none'] });

  {
    const s = [];
    const c = [];
    const server = https.createServer({ key, cert, handshakeTimeout: 300 }, () => s.push('request'));
    server.on('tlsClientError', (err) => s.push(`tlsClientError ${shown(err)}`));
    const port = await listen(server);
    await new Promise((resolve) => {
      const raw = net.connect(port, 'localhost');
      raw.on('end', () => c.push('end'));
      raw.on('close', () => {
        c.push('close');
        resolve();
      });
    });
    await close(server);
    report('https handshakeTimeout: a client that never says hello', s, c);
  }

  {
    const s = [];
    const c = [];
    const plain = net.createServer((raw) => {
      const socket = new tls.TLSSocket(raw, { isServer: true, key, cert, ALPNProtocols: ['x-a'] });
      socket.on('secure', () => {
        s.push(`secure: ${side(socket)}, requestCert ${socket._requestCert}, rejectUnauthorized ${socket._rejectUnauthorized}`);
        socket.end('hello from a TLSSocket');
      });
    });
    const port = await listen(plain);
    await new Promise((resolve) => {
      const socket = tls.connect({ host: 'localhost', port, servername: 'localhost', ca: cert, ALPNProtocols: ['x-a'] });
      let data = '';
      socket.on('data', (d) => (data += d));
      socket.on('close', () => {
        c.push(`got ${JSON.stringify(data)}, alpn ${socket.alpnProtocol}`);
        resolve();
      });
    });
    await close(plain);
    report('new tls.TLSSocket(socket, { isServer: true })', s, c);
  }

  const app = express();
  app.get('/hello/:name', (req, res) => res.json({ hello: req.params.name, secure: req.secure, protocol: req.protocol }));
  app.use((req, res) => res.status(404).type('text').send('none here'));
  const server = https.createServer({ key, cert }, app);
  const port = await listen(server);
  const lines = [await get(port, { ca: cert }, '/hello/express'), await get(port, { ca: cert }, '/missing')];
  await close(server);
  report('express over https', [], lines);
})();
