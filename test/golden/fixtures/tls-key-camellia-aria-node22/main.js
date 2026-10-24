const fs = require('fs');
const path = require('path');
const tls = require('tls');

const read = (name) => fs.readFileSync(path.join(__dirname, 'keys', name), 'utf8');
const cert = read('server.crt');
const CIPHERS = ['camellia-128-cbc', 'camellia-192-cbc', 'camellia-256-cbc', 'aria-128-cbc', 'aria-192-cbc', 'aria-256-cbc'];
const RIGHT = 'right passphrase';
const WRONG = 'wrong passphrase';

const shown = (e) => `${e.code} ${JSON.stringify(e.message)} (${e.library}, ${e.reason}) stack ${JSON.stringify(e.opensslErrorStack ?? null)}`;

const attempt = (label, fn) => {
  try {
    fn();
    console.log(`  ${label}: ok`);
  } catch (e) {
    console.log(`  ${label}: throws ${shown(e)}`);
  }
};

function serve(key, passphrase) {
  return new Promise((resolve) => {
    const server = tls.createServer({ key, cert, passphrase }, (s) => s.end('hi'));
    server.listen(0, '127.0.0.1', () => {
      const c = tls.connect({ host: '127.0.0.1', port: server.address().port, rejectUnauthorized: false });
      let got = '';
      c.on('data', (d) => (got += d));
      c.on('error', (e) => (got = `error ${e.code}`));
      c.on('close', () => server.close(() => resolve(got)));
    });
  });
}

function clientCert(key, passphrase) {
  return new Promise((resolve) => {
    const server = tls.createServer({ key: read('camellia-256-cbc.key'), passphrase: RIGHT, cert, requestCert: true, rejectUnauthorized: false }, (s) => {
      s.end(s.getPeerCertificate().subject ? 'with a client certificate' : 'without one');
    });
    server.listen(0, '127.0.0.1', () => {
      const c = tls.connect({ host: '127.0.0.1', port: server.address().port, rejectUnauthorized: false, key, cert, passphrase });
      let got = '';
      c.on('data', (d) => (got += d));
      c.on('error', (e) => (got = `error ${shown(e)}`));
      c.on('close', () => server.close(() => resolve(got)));
    });
  });
}

(async () => {
  for (const cipher of CIPHERS) {
    const key = read(`${cipher}.key`);
    console.log(cipher);
    attempt('createSecureContext, the right passphrase', () => tls.createSecureContext({ key, cert, passphrase: RIGHT }));
    attempt('createSecureContext, a wrong passphrase', () => tls.createSecureContext({ key, cert, passphrase: WRONG }));
    attempt('createSecureContext, no passphrase', () => tls.createSecureContext({ key, cert }));
    attempt('createServer, a wrong passphrase', () => tls.createServer({ key, cert, passphrase: WRONG }));
    console.log(`  a server with the key: the client got ${JSON.stringify(await serve(key, RIGHT))}`);
    console.log(`  a client certificate with the key: ${await clientCert(key, RIGHT)}`);
    attempt('tls.connect with the key, a wrong passphrase', () => {
      const c = tls.connect({ host: '127.0.0.1', port: 9, key, cert, passphrase: WRONG });
      c.on('error', () => {});
      c.destroy();
    });
  }
  console.log('done');
})();
