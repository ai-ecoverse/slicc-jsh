const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const https = require('https');

const read = (name) => fs.readFileSync(path.join(__dirname, 'keys', name), 'utf8');
const pair = (name) => ({ key: read(`${name}.key`), cert: read(`${name}.crt`) });
const own = pair('server');
const a = pair('a');
const wild = pair('wild');
const any = pair('any');
const clientCa = read('ca.crt');
const client = pair('client');

const shown = (err) => [err.code, err.library, err.reason ?? err.message].filter((v) => v !== undefined).join(' | ');
const cn = (socket) => socket.getPeerCertificate()?.subject?.CN ?? 'none';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function report(name, s, c) {
  console.log(name);
  for (const line of s) console.log('  server', line);
  for (const line of c) console.log('  client', line);
}

function dial(port, options, c) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, ...options });
    let data = '';
    socket.on('secureConnect', () => c.push(`secureConnect: cert ${cn(socket)}, alpn ${socket.alpnProtocol}`));
    socket.on('data', (d) => (data += d));
    socket.on('error', (err) => c.push(`error ${shown(err)}`));
    socket.on('close', () => {
      c.push(`got ${JSON.stringify(data)}`);
      resolve();
    });
  });
}

async function tlsCase(name, serverOptions, clientOptions, { contexts = [], s = [] } = {}) {
  const c = [];
  let served;
  const outcome = new Promise((resolve) => (served = resolve));
  let server;
  try {
    server = tls.createServer({ ...(serverOptions.own === false ? {} : own), ...serverOptions }, (socket) => {
      s.push(`secureConnection: servername ${socket.servername}, alpn ${socket.alpnProtocol}, cert ${socket.getCertificate()?.subject?.CN}`);
      socket.on('error', () => {});
      socket.on('close', served);
      socket.end('hello');
    });
  } catch (err) {
    console.log(name);
    console.log('  createServer throws', err.code, err.message);
    return;
  }
  for (const [servername, context] of contexts) server.addContext(servername, context);
  server.on('tlsClientError', (err, socket) => {
    s.push(`tlsClientError ${shown(err)}, destroyed ${socket.destroyed}`);
    served();
  });
  const port = await listen(server);
  await dial(port, clientOptions, c);
  await outcome;
  await close(server);
  report(name, s, c);
}

(async () => {
  await tlsCase('addContext: the name the client sends', {}, { servername: 'a.test' }, { contexts: [['a.test', a]] });
  await tlsCase('addContext: a wildcard', {}, { servername: 'x.wild.test' }, { contexts: [['a.test', a], ['*.wild.test', wild]] });
  await tlsCase('addContext: no context for the name', {}, { servername: 'b.test' }, { contexts: [['a.test', a]] });
  await tlsCase('addContext: the last added that matches', {}, { servername: 'a.test' }, { contexts: [['a.test', a], ['*.test', any]] });
  await tlsCase('addContext: a SecureContext', {}, { servername: 'a.test' }, { contexts: [['a.test', tls.createSecureContext(a)]] });
  await tlsCase('addContext: a client without SNI', {}, {}, { contexts: [['a.test', a]] });

  {
    const s = [];
    await tlsCase(
      'SNICallback: a context for the name',
      {
        SNICallback(servername, cb) {
          s.push(`SNICallback ${servername}, this is the socket ${this instanceof tls.TLSSocket}`);
          cb(null, tls.createSecureContext(servername === 'a.test' ? a : wild));
        },
      },
      { servername: 'a.test' },
      { s }
    );
  }
  {
    const s = [];
    await tlsCase(
      'SNICallback: later, a raw context',
      {
        SNICallback(servername, cb) {
          s.push(`SNICallback ${servername}`);
          setTimeout(() => cb(null, tls.createSecureContext(wild).context), 50);
        },
      },
      { servername: 'y.wild.test' },
      { s }
    );
  }
  {
    const s = [];
    await tlsCase(
      'SNICallback: no context',
      {
        SNICallback(servername, cb) {
          s.push(`SNICallback ${servername}`);
          cb(null);
        },
      },
      { servername: 'b.test' },
      { s }
    );
  }
  {
    const s = [];
    await tlsCase(
      'SNICallback: an error',
      {
        SNICallback(servername, cb) {
          s.push(`SNICallback ${servername}`);
          cb(new Error('no certificate for that name'));
        },
      },
      { servername: 'b.test' },
      { s }
    );
  }
  {
    const s = [];
    await tlsCase(
      'SNICallback: a client without SNI',
      {
        SNICallback(servername, cb) {
          s.push(`SNICallback ${servername}`);
          cb(null, tls.createSecureContext(a));
        },
      },
      {},
      { s }
    );
  }
  {
    const s = [];
    await tlsCase(
      'SNICallback over addContext',
      {
        SNICallback(servername, cb) {
          s.push(`SNICallback ${servername}`);
          cb(null, tls.createSecureContext(wild));
        },
      },
      { servername: 'a.test' },
      { s, contexts: [['a.test', a]] }
    );
  }

  {
    const s = [];
    await tlsCase(
      'ALPNCallback: its choice',
      {
        ALPNCallback(offer) {
          s.push(`ALPNCallback ${JSON.stringify(offer)}`);
          return offer.protocols[1];
        },
      },
      { servername: 'localhost', ALPNProtocols: ['x-a', 'x-b', 'x-c'] },
      { s }
    );
  }
  {
    const s = [];
    await tlsCase(
      'ALPNCallback: none of them',
      {
        ALPNCallback(offer) {
          s.push(`ALPNCallback ${JSON.stringify(offer)}`);
          return undefined;
        },
      },
      { ALPNProtocols: ['x-a'] },
      { s }
    );
  }
  {
    const s = [];
    await tlsCase(
      'ALPNCallback: one the client did not offer',
      {
        ALPNCallback(offer) {
          s.push(`ALPNCallback ${JSON.stringify(offer)}`);
          return 'x-z';
        },
      },
      { ALPNProtocols: ['x-a', 'x-b'] },
      { s }
    );
  }
  {
    const s = [];
    await tlsCase(
      'ALPNCallback: it throws',
      {
        ALPNCallback(offer) {
          s.push(`ALPNCallback ${JSON.stringify(offer)}`);
          throw new Error('no protocol today');
        },
      },
      { ALPNProtocols: ['x-a'] },
      { s }
    );
  }
  {
    const s = [];
    await tlsCase(
      'ALPNCallback: a client without ALPN',
      {
        ALPNCallback(offer) {
          s.push(`ALPNCallback ${JSON.stringify(offer)}`);
          return offer.protocols[0];
        },
      },
      {},
      { s }
    );
  }
  await tlsCase('ALPNCallback with ALPNProtocols', { ALPNCallback: () => 'x', ALPNProtocols: ['x'] }, {});

  {
    const s = [];
    await tlsCase(
      'SNICallback and ALPNCallback',
      {
        SNICallback(servername, cb) {
          s.push(`SNICallback ${servername}`);
          cb(null, tls.createSecureContext(a));
        },
        ALPNCallback(offer) {
          s.push(`ALPNCallback ${JSON.stringify(offer)}`);
          return offer.protocols[0];
        },
      },
      { servername: 'a.test', ALPNProtocols: ['x-a', 'x-b'] },
      { s }
    );
  }
  for (const servername of ['a.test', undefined]) {
    const s = [];
    await tlsCase(
      `SNICallback without a certificate of its own, ${servername ? 'SNI' : 'no SNI'}`,
      {
        own: false,
        SNICallback(name, cb) {
          s.push(`SNICallback ${name}`);
          cb(null, tls.createSecureContext(a));
        },
      },
      servername ? { servername } : {},
      { s }
    );
  }
  try {
    tls.createServer(own).addContext('a.test', { key: wild.key, cert: a.cert });
    console.log('addContext, a key for another certificate: no throw');
  } catch (err) {
    console.log('addContext, a key for another certificate: throws', err.code, err.message);
  }
  {
    const s = [];
    await tlsCase(
      'requestCert: a context with the same ca checks the client certificate',
      {
        ca: clientCa,
        requestCert: true,
        SNICallback(servername, cb) {
          cb(null, tls.createSecureContext({ ...a, ca: clientCa }));
        },
      },
      { servername: 'a.test', ...client },
      { s }
    );
  }
  {
    const s = [];
    const c = [];
    const server = tls.createServer(
      {
        ...own,
        ca: clientCa,
        requestCert: true,
        SNICallback(servername, cb) {
          cb(null, tls.createSecureContext({ ...own, ca: read('rogue.crt') }));
        },
      },
      (socket) => {
        s.push(`secureConnection: authorized ${socket.authorized}`);
        socket.end('hello');
      }
    );
    server.on('tlsClientError', () => s.push('tlsClientError'));
    const port = await listen(server);
    await new Promise((resolve) => {
      const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false, ...client });
      let data = '';
      socket.on('data', (d) => (data += d));
      socket.on('error', () => {});
      socket.on('close', () => {
        c.push(`got ${JSON.stringify(data)}`);
        resolve();
      });
    });
    await close(server);
    report("requestCert: a context whose ca doesn't issue the client certificate refuses it", s, c);
  }
  await tlsCase('addContext and ALPNProtocols', { ALPNProtocols: ['h2', 'http/1.1'] }, { servername: 'a.test', ALPNProtocols: ['http/1.1', 'h2'] }, { contexts: [['a.test', a]] });
  await tlsCase('addContext and ALPNProtocols, none in common', { ALPNProtocols: ['h2'] }, { servername: 'a.test', ALPNProtocols: ['x-none'] }, { contexts: [['a.test', a]] });

  {
    const s = [];
    const c = [];
    const server = https.createServer(
      {
        ...own,
        SNICallback(servername, cb) {
          cb(null, tls.createSecureContext(servername === 'a.test' ? a : own));
        },
      },
      (req, res) => {
        s.push(`request ${req.url}: servername ${req.socket.servername}`);
        res.end('ok');
      }
    );
    const port = await listen(server);
    for (const name of ['a.test', 'localhost']) {
      await new Promise((resolve) => {
        https.get({ host: '127.0.0.1', port, path: `/${name}`, servername: name, rejectUnauthorized: false, agent: false }, (res) => {
          c.push(`${name}: ${res.statusCode}, cert ${cn(res.socket)}`);
          res.resume();
          res.on('end', resolve);
        }).on('error', (err) => {
          c.push(`${name}: error ${shown(err)}`);
          resolve();
        });
      });
    }
    await close(server);
    report('https with SNICallback', s, c);
  }

  {
    const s = [];
    const c = [];
    const plain = net.createServer((raw) => {
      const socket = new tls.TLSSocket(raw, {
        isServer: true,
        ...own,
        SNICallback(servername, cb) {
          s.push(`SNICallback ${servername}`);
          cb(null, tls.createSecureContext(a));
        },
      });
      socket.on('secure', () => {
        s.push(`secure: servername ${socket.servername}`);
        socket.end('hello from a TLSSocket');
      });
    });
    const port = await listen(plain);
    await dial(port, { servername: 'a.test' }, c);
    await close(plain);
    report('new tls.TLSSocket(socket, { isServer: true, SNICallback })', s, c);
  }
})();
