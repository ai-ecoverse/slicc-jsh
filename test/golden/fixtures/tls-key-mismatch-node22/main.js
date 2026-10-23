const fs = require('fs');
const path = require('path');
const tls = require('tls');
const https = require('https');

const read = (name) => fs.readFileSync(path.join(__dirname, 'keys', name), 'utf8');
const shown = (e) => [e.name, e.code, e.message, JSON.stringify(Object.entries(e))].join(' | ');
const attempt = (label, fn) => {
  try {
    console.log(label, '|', fn());
  } catch (e) {
    console.log(label, '| threw', shown(e));
  }
};

attempt("createSecureContext, a client certificate with another certificate's key", () => tls.createSecureContext({ cert: read('client.crt'), key: read('a.key') }) && 'made');
attempt("createSecureContext, a server certificate with another certificate's key", () => tls.createSecureContext({ cert: read('server.crt'), key: read('client.key') }) && 'made');
attempt('createSecureContext, a leaf and its issuer with the issuer-less key', () => tls.createSecureContext({ cert: [read('client.crt'), read('ca.crt')], key: read('server.key') }) && 'made');
attempt('createSecureContext, a key given as [{ pem }]', () => tls.createSecureContext({ cert: read('a.crt'), key: [{ pem: read('client.key') }] }) && 'made');
attempt('createSecureContext, the matching key', () => tls.createSecureContext({ cert: read('client.crt'), key: read('client.key') }) && 'made');
attempt('createSecureContext, a certificate alone', () => tls.createSecureContext({ cert: read('client.crt') }) && 'made');
attempt('createSecureContext, a key alone', () => tls.createSecureContext({ key: read('a.key') }) && 'made');
attempt("tls.connect, another certificate's key", () => {
  const s = tls.connect({ host: '127.0.0.1', port: 9, cert: read('client.crt'), key: read('a.key') });
  s.on('error', (e) => console.log("tls.connect, another certificate's key | error", e.code));
  return 'returned';
});
attempt("https.request, another certificate's key", () => {
  const req = https.request({ host: '127.0.0.1', port: 9, agent: false, cert: read('client.crt'), key: read('a.key') });
  req.on('error', (e) => console.log("https.request, another certificate's key | error", shown(e)));
  req.end();
  return 'returned';
});
attempt("tls.createServer, another certificate's key", () => tls.createServer({ cert: read('server.crt'), key: read('a.key') }) && 'made');
attempt("addContext, another certificate's key", () => {
  tls.createServer({ cert: read('server.crt'), key: read('server.key') }).addContext('a.test', { cert: read('a.crt'), key: read('client.key') });
  return 'added';
});
