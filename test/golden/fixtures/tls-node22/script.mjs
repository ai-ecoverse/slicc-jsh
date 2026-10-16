// require('tls') and import 'node:tls': Node 22.22.0's export surface, and its pure parts.
import tlsDefault, { checkServerIdentity, TLSSocket, Server, connect, rootCertificates, DEFAULT_MIN_VERSION } from 'node:tls';
import * as ns from 'tls';
import { createRequire, isBuiltin, builtinModules } from 'node:module';

const require = createRequire(import.meta.url);
const tls = require('tls');
const net = require('net');
const show = (label, f) => {
  try {
    console.log(label, JSON.stringify(f()));
  } catch (e) {
    console.log(label, 'throws', e.name, e.code, e.message);
  }
};

show('keys', () => Object.keys(tls));
show('same', () => [require('node:tls') === tls, tlsDefault === tls, ns.default === tls, checkServerIdentity === tls.checkServerIdentity, TLSSocket === tls.TLSSocket, Server === tls.Server, connect === tls.connect, DEFAULT_MIN_VERSION]);
show('esm keys', () => Object.keys(ns).sort());
show('builtin', () => [isBuiltin('tls'), isBuiltin('node:tls'), builtinModules.includes('tls')]);
show('functions', () => Object.entries(tls).filter(([, v]) => typeof v === 'function').map(([k, v]) => `${k}:${v.name}/${v.length}`));
show('settings', () => [tls.CLIENT_RENEG_LIMIT, tls.CLIENT_RENEG_WINDOW, tls.DEFAULT_CIPHERS, tls.DEFAULT_ECDH_CURVE, tls.DEFAULT_MIN_VERSION, tls.DEFAULT_MAX_VERSION]);
show('getCiphers', () => [tls.getCiphers(), tls.getCiphers() !== tls.getCiphers(), Object.isFrozen(tls.getCiphers())]);
show('rootCertificates', () => {
  const d = Object.getOwnPropertyDescriptor(tls, 'rootCertificates');
  return [typeof d.get, d.set, d.enumerable, d.configurable, Array.isArray(rootCertificates), Object.isFrozen(rootCertificates), tls.rootCertificates === tls.rootCertificates, tls.getCACertificates('bundled') === tls.rootCertificates];
});
show('getCACertificates', () => ['default', 'system', 'extra'].map((t) => Array.isArray(tls.getCACertificates(t)) && Object.isFrozen(tls.getCACertificates(t))));
show('getCACertificates bad', () => tls.getCACertificates('nope'));
show('getCACertificates 1', () => tls.getCACertificates(1));
show('setDefaultCACertificates str', () => tls.setDefaultCACertificates('x'));
show('setDefaultCACertificates [1]', () => tls.setDefaultCACertificates(['', 1]));

// checkServerIdentity: undefined, or Node's ERR_TLS_CERT_ALTNAME_INVALID.
const csi = (host, cert) => {
  try {
    const err = tls.checkServerIdentity(host, cert);
    if (err === undefined) return 'ok';
    return [err.name, err.code, err.message, Object.keys(err), err.reason, err.host, err.cert === cert, err instanceof Error];
  } catch (e) {
    return ['throws', e.name, e.code, e.message];
  }
};
const cases = [
  ['a.com', { subjectaltname: 'DNS:a.com' }],
  ['A.COM.', { subjectaltname: 'DNS:a.com' }],
  ['a.com', { subjectaltname: 'DNS:A.com.' }],
  ['b.com', { subjectaltname: 'DNS:a.com, DNS:c.com' }],
  ['www.a.com', { subjectaltname: 'DNS:*.a.com' }],
  ['a.com', { subjectaltname: 'DNS:*.a.com' }],
  ['x.y.a.com', { subjectaltname: 'DNS:*.a.com' }],
  ['foo.com', { subjectaltname: 'DNS:*.com' }],
  ['wwwbar.a.com', { subjectaltname: 'DNS:www*.a.com' }],
  ['bazwww.a.com', { subjectaltname: 'DNS:*www.a.com' }],
  ['ab.a.com', { subjectaltname: 'DNS:a*b*.a.com' }],
  ['xn--bcher-kva.example', { subjectaltname: 'DNS:xn--*.example' }],
  ['xn--bcher-kva.example', { subjectaltname: 'DNS:xn--bcher-kva.example' }],
  ['a..com', { subjectaltname: 'DNS:a..com' }],
  ['bücher.example', { subjectaltname: 'DNS:bücher.example' }],
  ['a.com', { subject: { CN: 'a.com' } }],
  ['b.com', { subject: { CN: 'a.com' } }],
  ['b.com', { subject: { CN: ['a.com', 'b.com'] } }],
  ['c.com', { subject: { CN: ['a.com', 'b.com'] } }],
  ['a.com', { subject: { CN: 'a.com' }, subjectaltname: 'DNS:b.com' }],
  ['a.com', { subject: { CN: 'a.com' }, subjectaltname: 'URI:http://a.com/' }],
  ['a.com', {}],
  ['a.com', { subject: {} }],
  ['127.0.0.1', { subjectaltname: 'IP Address:127.0.0.1' }],
  ['127.0.0.1', { subjectaltname: 'DNS:127.0.0.1' }],
  ['127.0.0.2', { subjectaltname: 'IP Address:127.0.0.1, IP Address:10.0.0.1' }],
  ['127.0.0.1', { subject: { CN: '127.0.0.1' } }],
  ['::1', { subjectaltname: 'IP Address:0:0:0:0:0:0:0:1' }],
  ['2001:db8::1', { subjectaltname: 'IP Address:2001:0DB8:0000:0000:0000:0000:0000:0001' }],
  ['2001:db8:0:0:1:0:0:1', { subjectaltname: 'IP Address:2001:db8::1:0:0:1' }],
  ['::ffff:1.2.3.4', { subjectaltname: 'IP Address:0:0:0:0:0:ffff:102:304' }],
  ['fe80::1%eth0', { subjectaltname: 'IP Address:fe80::1' }],
  ['::2', { subjectaltname: 'IP Address:::2, IP Address:010.0.0.1, IP Address:1:2:3:4:5:6:7:8, IP Address:1:0:0:2:0:0:0:3, IP Address:::1.2.3.4, IP Address:bogus' }],
  ['a.com', { subjectaltname: 'DNS:"a.com"' }],
  ['a.com', { subjectaltname: 'DNS:"a\\u002ecom", DNS:b.com' }],
  ['a,b.com', { subjectaltname: 'DNS:"a,b.com"' }],
  ['a.com', { subjectaltname: 'DNS:"a.com' }],
  [123, { subjectaltname: 'DNS:123' }],
];
for (const [host, cert] of cases) show(`checkServerIdentity ${JSON.stringify(host)} ${JSON.stringify(cert)}`, () => csi(host, cert));

const alpn = (protocols) => {
  const out = {};
  tls.convertALPNProtocols(protocols, out);
  return out.ALPNProtocols === undefined ? 'unset' : [Buffer.isBuffer(out.ALPNProtocols), [...out.ALPNProtocols]];
};
show('alpn array', () => alpn(['h2', 'http/1.1', 'é']));
show('alpn u8', () => alpn(new Uint8Array([2, 104, 50])));
show('alpn view', () => alpn(new DataView(new Uint8Array([9, 2, 104, 50, 9]).buffer, 1, 3)));
show('alpn string', () => alpn('h2'));
show('alpn too long', () => alpn(['a', 'x'.repeat(256)]));

show('createSecureContext', () => {
  const c = tls.createSecureContext();
  const d = tls.SecureContext();
  return [c instanceof tls.SecureContext, d instanceof tls.SecureContext, typeof c.context, typeof tls.createSecureContext({ minVersion: 'TLSv1', maxVersion: 'TLSv1.3', ciphers: 'HIGH', ecdhCurve: 'P-256', honorCipherOrder: true, sessionTimeout: 10, sessionIdContext: 'x', ticketKeys: Buffer.alloc(48) })];
});
show('ctx minVersion', () => tls.createSecureContext({ minVersion: 'TLSv1.4' }));
show('ctx maxVersion', () => tls.createSecureContext({ maxVersion: 3 }));
show('ctx conflict', () => tls.createSecureContext({ secureProtocol: 'TLSv1_2_method', minVersion: 'TLSv1.2' }));
show('ctx secureOptions', () => tls.createSecureContext({ secureOptions: 1.5 }));
show('ctx ciphers type', () => tls.createSecureContext({ ciphers: 123 }));
show('ctx ciphers empty', () => tls.createSecureContext({ ciphers: ':' }));
show('ctx ecdhCurve', () => tls.createSecureContext({ ecdhCurve: 1 }));
show('ctx sigalgs', () => tls.createSecureContext({ sigalgs: '' }));
show('ctx ticketKeys', () => tls.createSecureContext({ ticketKeys: Buffer.alloc(47) }));
show('ctx sessionTimeout', () => tls.createSecureContext({ sessionTimeout: -1 }));
show('ctx ca type', () => tls.createSecureContext({ ca: [1] }));
show('ctx cert type', () => tls.createSecureContext({ cert: {} }));
show('ctx crl type', () => tls.createSecureContext({ crl: 5 }));
show('ctx clientCertEngine', () => tls.createSecureContext({ clientCertEngine: 5 }));
show('ctx engine', () => tls.createSecureContext({ privateKeyIdentifier: 'x' }));
show('ctx options', () => tls.createSecureContext(5));

show('classes', () => [
  Object.getPrototypeOf(tls.TLSSocket) === net.Socket,
  Object.getPrototypeOf(tls.TLSSocket.prototype) === net.Socket.prototype,
  Object.getPrototypeOf(tls.Server) === net.Server,
  Object.getPrototypeOf(tls.Server.prototype) === net.Server.prototype,
  ['disableRenegotiation', 'renegotiate', 'exportKeyingMaterial', 'setMaxSendFragment', 'setServername', 'setSession', 'getPeerCertificate', 'getCertificate', 'getPeerX509Certificate', 'getX509Certificate', 'setKeyCert', 'getCipher', 'getSharedSigalgs', 'getEphemeralKeyInfo', 'getFinished', 'getPeerFinished', 'getProtocol', 'getSession', 'getTLSTicket', 'isSessionReused', 'enableTrace'].every((m) => typeof tls.TLSSocket.prototype[m] === 'function'),
  ['setSecureContext', 'getTicketKeys', 'setTicketKeys', 'addContext'].every((m) => typeof tls.Server.prototype[m] === 'function'),
]);
show('TLSSocket', () => {
  class Mine extends tls.TLSSocket {
    constructor() {
      super(undefined, { ALPNProtocols: ['h2'] });
      this.mine = true;
    }
  }
  const s = new Mine();
  const r = [s instanceof Mine, s instanceof tls.TLSSocket, s instanceof net.Socket, s.mine, s.encrypted, s.authorized, s.authorizationError, s.secureConnecting, s.servername, s.alpnProtocol, [...s._tlsOptions.ALPNProtocols]];
  for (const [label, f] of [
    ['exportKeyingMaterial 0', () => s.exportKeyingMaterial(0, 'x')],
    ['exportKeyingMaterial label', () => s.exportKeyingMaterial(16, 1)],
    ['exportKeyingMaterial', () => s.exportKeyingMaterial(16, 'x')],
    ['setServername', () => s.setServername(1)],
    ['setMaxSendFragment', () => s.setMaxSendFragment('x')],
    ['renegotiate', () => s.renegotiate(null)],
  ]) {
    try {
      r.push(label, f());
    } catch (e) {
      r.push(label, e.name, e.code, e.message);
    }
  }
  s.destroy();
  return r;
});
show('TLSSocket enableTrace', () => new tls.TLSSocket(null, { enableTrace: 1 }));
show('Server', () => {
  const a = tls.createServer({ requestCert: true, ALPNProtocols: ['h2'] }, () => {});
  const b = tls.Server();
  class Mine extends tls.Server {}
  const c = new Mine({ rejectUnauthorized: false });
  return [a instanceof tls.Server, a instanceof net.Server, b instanceof tls.Server, c instanceof Mine, c instanceof tls.Server, a.requestCert, a.rejectUnauthorized, c.rejectUnauthorized, [...a.ALPNProtocols], a.listenerCount('secureConnection'), a.getTicketKeys().length, Buffer.isBuffer(a.getTicketKeys()), a.listening];
});
show('Server options', () => tls.createServer(5));
show('Server ALPN both', () => tls.createServer({ ALPNCallback: () => {}, ALPNProtocols: ['h2'] }));
show('Server handshakeTimeout', () => tls.createServer({ handshakeTimeout: 'x' }));
show('Server SNICallback', () => tls.createServer({ SNICallback: 1 }));
show('Server addContext', () => tls.createServer().addContext(''));
show('connect checkServerIdentity', () => tls.connect({ port: 1, checkServerIdentity: 1 }));
show('connect minDHSize', () => tls.connect({ port: 1, minDHSize: 0 }));
