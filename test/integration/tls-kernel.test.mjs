import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createTcp, connect as tcp } from 'node:net';
import { createPrivateKey } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { devPackageTree, withJsh } from './helpers.mjs';
import { makeCa, selfSigned } from './tls-certs.mjs';
import { TLSSocket } from 'node:tls';
import { node22Bin } from '../../scripts/node22.mjs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';

const modules = fileURLToPath(new URL('../../node_modules', import.meta.url));

// slicc-kernel 1.124.0 (ai-ecoverse/slicc-kernel#922) runs the TLS
// handshake itself for a host its uplink routes: any port and protocol, a
// custom ca, STARTTLS over an open connection, and the session (protocol,
// ALPN, the server's chain) for jsh's TLSSocket. The kernel here has a fake
// uplink whose peers are real Node TLS servers on the host, and the TLS
// engine installed; a program's output is compared with host Node 22.22.0's,
// the same program against the same server.
// slicc-kernel 1.124.13 (ai-ecoverse/slicc-kernel#1004): a client
// certificate, `sni: false`, and the cipher in the session.
// slicc-kernel 1.125.2 (ai-ecoverse/slicc-kernel#1057): a server's alert has
// its number, and the chain's verdict comes apart from the name's.

const UPLINK = '203.0.113.10';

// A key encrypted with the passphrase 'pw', fixed rather than made per run.
// OpenSSL decrypts it with the passphrase given, or an empty one. For about
// one random salt and IV in 500 the result passes the padding check, and
// Node then says DECODER unsupported, not bad decrypt (jsh decrypts the key
// itself to tell them apart, golden tls-wrong-passphrase-node22). Host Node 22.22.0 gives bad decrypt for this
// key with no passphrase, '' and 'not it'.
const LOCKED_KEY = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIH0MF8GCSqGSIb3DQEFDTBSMDEGCSqGSIb3DQEFDDAkBBBdGALvtdtyJoUW4sQG
GNpGAgIIADAMBggqhkiG9w0CCQUAMB0GCWCGSAFlAwQBKgQQia1ICps8rs6+YP9I
nvzsjgSBkEn5S9P+PPJ2DEoWI7JNhcsorOtIExRSMQHtNdwXjuXoZUYORxUM410H
jqYg9sVv8YGiZmPAca5C4lrtFgOGZu9WsjZc+BH/HA/DWkgpJCOEFlMTvwngfBuR
x1XCyVqYRlbvEBtYrlpIsIgGiaUShbBxfqBpqfBT5gq9o38SX6Ivw4ESgdoYn4Xn
QQB/lzaXfQ==
-----END ENCRYPTED PRIVATE KEY-----
`;

/** An uplink peer that pipes the program's bytes to a server on the host. */
function pipeTo(port) {
  return (peer) => {
    const sock = tcp(port, '127.0.0.1');
    sock.on('data', (d) => peer.write(new Uint8Array(d)));
    sock.on('end', () => peer.end());
    sock.on('error', () => peer.end());
    void (async () => {
      for (;;) {
        const bytes = await peer.read().catch(() => null);
        if (!bytes) {
          sock.end();
          return;
        }
        sock.write(bytes);
      }
    })();
  };
}

function listen(server) {
  // smtp-server's SMTPServer keeps its net.Server as .server.
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address ? server : server.server).address().port)));
}

function hostNode(dir, file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(node22Bin(), [join(dir, file), ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('tls through the kernel handshake (kernel 1.124.0)', () => {
  let jsh;
  let dir;
  const ca = makeCa();
  const servers = [];
  const peers = {};
  const ports = {};
  const sunk = [];
  let rsaPem;
  const mail = [];
  const connects = [];
  let clientFiles;

  /** Run `source` as `file` in host Node 22 (against 127.0.0.1) and in jsh (against the uplink). */
  async function both(file, source, port, { address = false } = {}) {
    writeFileSync(join(dir, file), source);
    await jsh.kernel.writeFile(`/os/${file}`, source);
    const [host, shim] = await Promise.all([
      hostNode(dir, file, ['127.0.0.1', typeof port === 'object' ? JSON.stringify(port) : String(port), dir, modules]),
      jsh.run(['node', file, UPLINK, typeof port === 'object' ? JSON.stringify(port) : String(port), '/os', '/os/node_modules']),
    ]);
    // The one difference by design: the address each reaches its server at.
    if (address) shim.stdout = shim.stdout.replaceAll(UPLINK, '127.0.0.1');
    return { host, shim };
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jsh-tls-kernel-'));
    writeFileSync(join(dir, 'ca.pem'), ca.pem);
    const leaf = ca.server('secure.test', {
      subject: [['C', 'DE'], ['O', 'slicc'], ['OU', 'a'], ['OU', 'b'], ['CN', 'secure.test']],
      san: ['DNS:secure.test', 'DNS:*.secure.test', 'IP:203.0.113.10', 'email:ops@secure.test', 'URI:https://secure.test/x'],
      aia: { ocsp: 'http://ocsp.secure.test', caIssuers: 'http://ca.secure.test/ca.der' },
    });
    const echoing = (s) => s.on('data', (d) => s.write(d));
    const tlsServer = async (name, options) => {
      const server = createTlsServer(options, echoing);
      server.on('tlsClientError', () => {});
      servers.push(server);
      ports[name] = await listen(server);
    };
    await tlsServer('echo', { key: leaf.key, cert: leaf.cert, ALPNProtocols: ['echo/1'] });
    const hello = createTlsServer({ key: leaf.key, cert: leaf.cert }, (s) => s.end('hello'));
    hello.on('tlsClientError', () => {});
    servers.push(hello);
    ports.hello = await listen(hello);
    const other = makeCa('another CA');
    const day = 86400_000;
    const plainLeaf = ca.server('secure.test');
    await tlsServer('untrusted', other.server('secure.test'));
    const otherLeaf = other.server('secure.test');
    await tlsServer('leafOnlyUntrusted', { key: otherLeaf.key, cert: otherLeaf.leafOnly });
    await tlsServer('selfSigned', selfSigned('secure.test'));
    await tlsServer('expired', ca.server('secure.test', { notBefore: new Date(Date.now() - 3 * day), notAfter: new Date(Date.now() - day) }));
    await tlsServer('wrongName', ca.server('other.test'));
    const sink = createTlsServer(ca.server('other.test'), (sock) => sock.on('data', (d) => sunk.push(String(d))));
    sink.on('tlsClientError', () => {});
    servers.push(sink);
    ports.sink = await listen(sink);
    await tlsServer('leafOnly', { key: plainLeaf.key, cert: plainLeaf.leafOnly });
    const rsa = makeCa('RSA CA', { rsa: true });
    writeFileSync(join(dir, 'rsa.pem'), rsa.pem);
    rsaPem = rsa.pem;
    await tlsServer('rsa', rsa.server('secure.test', { rsa: true }));
    await tlsServer('tls12', { ...plainLeaf, maxVersion: 'TLSv1.2' });
    // Self-issued (its issuer's name is its own) but signed by another key,
    // as a CA's rollover certificate is: not self-signed.
    const rollover = makeCa('secure.test').server('secure.test');
    await tlsServer('selfIssued', { key: rollover.key, cert: rollover.leafOnly });
    // A certificate for clients only, with another name.
    await tlsServer('clientOnlyWrongName', ca.server('other.test', { eku: ['1.3.6.1.5.5.7.3.2'] }));
    // A key usage no TLS server may have (keyCertSign only), with another name.
    await tlsServer('badUsageWrongName', ca.server('other.test', { keyUsage: [0x04, 2] }));
    // A server that hangs up before the handshake.
    const hangup = createTcp((sock) => sock.end());
    servers.push(hangup);
    ports.hangup = await listen(hangup);
    // STARTTLS: a line in plain text, OK, then TLS on the same connection.
    const starttls = createTcp((sock) => {
      sock.once('data', (d) => {
        if (String(d).trim() !== 'STARTTLS') return sock.end('NO\r\n');
        sock.write('OK\r\n');
        const secure = new TLSSocket(sock, { isServer: true, key: plainLeaf.key, cert: plainLeaf.cert });
        secure.on('error', () => {});
        echoing(secure);
      });
    });
    servers.push(starttls);
    ports.starttls = await listen(starttls);
    // A minimal PostgreSQL server: SSLRequest, 'S', TLS, startup, one simple query.
    const pgServer = (leafFor, tlsExtra = {}) =>
      createTcp((sock) => {
        sock.once('data', (d) => {
          if (d.length !== 8 || d.readInt32BE(4) !== 80877103) return sock.destroy();
          sock.write('S');
          const secure = new TLSSocket(sock, { isServer: true, key: leafFor.key, cert: leafFor.cert, ...tlsExtra });
          secure.on('error', () => {});
          let buf = Buffer.alloc(0);
          let started = false;
          const msg = (type, body) => {
            const head = Buffer.alloc(5);
            head.write(type, 0);
            head.writeInt32BE(body.length + 4, 1);
            return Buffer.concat([head, body]);
          };
          const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
          const int16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
          const cstr = (t) => Buffer.from(`${t}\0`);
          secure.on('data', (d2) => {
            buf = Buffer.concat([buf, d2]);
            for (;;) {
              if (!started) {
                if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
                const n = buf.readInt32BE(0);
                const params = buf.subarray(8, n).toString().split('\0');
                buf = buf.subarray(n);
                started = true;
                secure.write(Buffer.concat([
                  msg('R', int32(0)),
                  msg('S', Buffer.concat([cstr('server_version'), cstr('16.0')])),
                  msg('S', Buffer.concat([cstr('user_seen'), cstr(params[1] ?? '')])),
                  msg('K', Buffer.concat([int32(7), int32(9)])),
                  msg('Z', Buffer.from('I')),
                ]));
                continue;
              }
              if (buf.length < 5 || buf.length < 1 + buf.readInt32BE(1)) return;
              const type = String.fromCharCode(buf[0]);
              const n = buf.readInt32BE(1);
              const body = buf.subarray(5, 1 + n);
              buf = buf.subarray(1 + n);
              if (type === 'X') return secure.end();
              if (type !== 'Q') continue;
              const sql = body.subarray(0, body.length - 1).toString();
              const as = tlsExtra.requestCert ? ` as ${secure.getPeerCertificate().subject?.CN}` : '';
              const value = Buffer.from(`over ${secure.getProtocol()}${as}: ${sql}`);
              secure.write(Buffer.concat([
                msg('T', Buffer.concat([int16(1), cstr('answer'), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0)])),
                msg('D', Buffer.concat([int16(1), int32(value.length), value])),
                msg('C', cstr('SELECT 1')),
                msg('Z', Buffer.from('I')),
              ]));
            }
          });
        });
      });
    const dbLeaf = ca.server('db.test', { san: ['DNS:db.test', 'IP:127.0.0.1', `IP:${UPLINK}`] });
    const requireCert = { requestCert: true, rejectUnauthorized: true, ca: ca.pem };
    for (const [name, leafFor, tlsExtra] of [['pg', dbLeaf], ['pgUntrusted', other.server('db.test')], ['pgMtls', dbLeaf, requireCert]]) {
      const server = pgServer(leafFor, tlsExtra);
      servers.push(server);
      ports[name] = await listen(server);
    }
    // SMTP with STARTTLS (smtp-server), and with TLS from the start (SMTPS).
    const { SMTPServer } = await import('smtp-server');
    const mailLeaf = ca.server('mail.test');
    for (const [name, secure] of [['smtp', false], ['smtps', true]]) {
      const smtp = new SMTPServer({
        secure,
        key: mailLeaf.key,
        cert: mailLeaf.cert,
        name: 'mail.test',
        banner: 'test server',
        authOptional: true,
        logger: false,
        onData(stream, session, cb) {
          let data = '';
          stream.on('data', (c) => (data += c));
          stream.on('end', () => {
            mail.push(`${name} secure=${session.secure} from=${session.envelope.mailFrom.address} subject=${/^Subject: (.*)$/m.exec(data)?.[1]}`);
            cb();
          });
        },
      });
      smtp.on('error', () => {});
      servers.push(smtp);
      ports[name] = await listen(smtp);
    }
    // An HTTPS server (trailers, keep-alive, header case) and a CONNECT proxy in front of it.
    const https = createHttpsServer({ key: plainLeaf.key, cert: plainLeaf.cert }, (req, res) => {
      res.sendDate = false;
      if (req.url === '/trailers') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Mixed-Case': 'yes', Trailer: 'X-Checksum' });
        res.write('part one, ');
        res.addTrailers({ 'X-Checksum': 'abc123' });
        res.end('part two');
        return;
      }
      res.setHeader('X-Seen-Host', String(req.headers.host));
      res.setHeader('X-Seen-Raw', req.rawHeaders.filter((_, i) => i % 2 === 0).join(','));
      res.end(`${req.method} ${req.url}`);
    });
    servers.push(https);
    ports.https = await listen(https);
    const proxy = createHttpServer();
    proxy.on('connect', (req, sock, head) => {
      connects.push(req.url.replace(/:\d+$/, ':PORT'));
      const up = tcp(ports.https, '127.0.0.1', () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.write(head);
        up.pipe(sock);
        sock.pipe(up);
      });
      up.on('error', () => sock.destroy());
      sock.on('error', () => up.destroy());
    });
    servers.push(proxy);
    ports.proxy = await listen(proxy);
    // Client certificates and SNI: servers that say whose certificate they
    // got and the server name they were sent.
    const named = ca.server('secure.test', { san: ['DNS:secure.test', 'IP:127.0.0.1', `IP:${UPLINK}`] });
    const client = ca.server('client.test', { eku: ['1.3.6.1.5.5.7.3.2'] });
    const encrypted = createPrivateKey(client.key).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' });
    clientFiles = { 'client.pem': client.cert, 'client.key': client.key, 'client-enc.key': encrypted, 'locked.key': LOCKED_KEY, 'other.key': named.key };
    for (const [file, data] of Object.entries(clientFiles)) writeFileSync(join(dir, file), data);
    const telling = (s) => s.end(`client=${s.getPeerCertificate().subject?.CN ?? 'none'} sni=${s.servername}`);
    const tellingServer = async (name, options) => {
      const server = createTlsServer({ key: named.key, cert: named.cert, ...options }, telling);
      server.on('tlsClientError', () => {});
      servers.push(server);
      ports[name] = await listen(server);
    };
    await tellingServer('mtls', requireCert);
    await tellingServer('mtls12', { ...requireCert, maxVersion: 'TLSv1.2' });
    await tellingServer('sni', {});
    // The server's choice of suite, so both clients get the same one.
    await tellingServer('cipher13', { ciphers: 'TLS_AES_128_GCM_SHA256', honorCipherOrder: true });
    await tellingServer('cipher12', { ciphers: 'ECDHE-ECDSA-AES256-GCM-SHA384', honorCipherOrder: true, maxVersion: 'TLSv1.2' });
    const starttlsSni = createTcp((sock) => {
      sock.once('data', () => {
        sock.write('OK\r\n');
        const secure = new TLSSocket(sock, { isServer: true, key: named.key, cert: named.cert, SNICallback: (n, cb) => cb(null) });
        secure.on('error', () => {});
        secure.on('secure', () => telling(secure));
      });
    });
    servers.push(starttlsSni);
    ports.starttlsSni = await listen(starttlsSni);
    const mtlsHttps = createHttpsServer({ key: named.key, cert: named.cert, ...requireCert }, (req, res) => {
      res.end(`client=${req.socket.getPeerCertificate().subject?.CN} sni=${req.socket.servername} ${req.url}`);
    });
    servers.push(mtlsHttps);
    ports.mtlsHttps = await listen(mtlsHttps);
    for (const port of Object.values(ports)) peers[`${UPLINK}:${port}`] = pipeTo(port);
    const { fakeUplink } = await import('@ai-ecoverse/slicc-kernel/testing');
    jsh = await withJsh({ uplink: fakeUplink({ names: { 'secure.test': [UPLINK] }, routes: { prefixes: [], exit: true }, peers }), tlsEngine: true });
    for (const name of ['pg', 'nodemailer', 'https-proxy-agent']) {
      for (const [path, data] of devPackageTree(name)) await jsh.kernel.writeFile(`/os${path}`, data);
    }
    await jsh.kernel.writeFile('/os/ca.pem', ca.pem);
    await jsh.kernel.writeFile('/os/rsa.pem', rsaPem);
    for (const [file, data] of Object.entries(clientFiles)) await jsh.kernel.writeFile(`/os/${file}`, data);
  });
  after(async () => {
    await jsh?.close();
    for (const s of servers) s.close?.();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a raw TLS echo on a non-HTTP port, with a custom ca and ALPN: the session and certificate as Node shows them', async () => {
    const { host, shim } = await both(
      'echo.js',
      `const tls = require('tls');
const fs = require('fs');
const [host, port, dir] = process.argv.slice(2);
const s = tls.connect({ host, port: Number(port), servername: 'secure.test', ca: fs.readFileSync(dir + '/ca.pem'), ALPNProtocols: ['echo/1'] }, () => {
  console.log('secureConnect', s.authorized, s.authorizationError, s.alpnProtocol, s.servername, s.getProtocol(), s.isSessionReused(), s.encrypted);
  const c = s.getPeerCertificate(true);
  const show = (o) => JSON.stringify(o, (k, v) => (k === 'issuerCertificate' ? (v === o ? '[self]' : v) : v && v.type === 'Buffer' ? k + ':' + Buffer.from(v.data).toString('hex').slice(0, 40) + ':' + v.data.length : v));
  console.log('leaf keys', Object.keys(c).join());
  console.log('leaf', show({ ...c, issuerCertificate: undefined }));
  console.log('issuer', show({ ...c.issuerCertificate, issuerCertificate: c.issuerCertificate.issuerCertificate === c.issuerCertificate ? 'self' : 'other' }));
  console.log('null protos', Object.getPrototypeOf(c.subject), Object.getPrototypeOf(c.infoAccess), Buffer.isBuffer(c.raw));
  console.log('short', Object.keys(s.getPeerCertificate()).join());
  s.write('ping\\n');
});
s.on('connect', () => console.log('connect'));
s.on('secure', () => console.log('secure'));
s.setEncoding('utf8');
s.on('data', (d) => { console.log('echo', d.trim()); s.end(); });
s.on('end', () => console.log('end'));
s.on('close', (hadError) => console.log('close', hadError));
s.on('error', (e) => console.log('error', e.code, e.message));
`,
      ports.echo
    );
    assert.equal(host.status, 0, host.stderr);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
  });

  it('a peer jsh refuses gets none of what the program wrote before the handshake: a wrong name, an untrusted chain, a checkServerIdentity that refuses', async () => {
    sunk.length = 0;
    const { host, shim } = await both(
      'refused-gets-nothing.js',
      `const tls = require('tls');
const fs = require('fs');
const [host, portsJson, dir] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const ca = fs.readFileSync(dir + '/ca.pem');
const go = (label, opts) => new Promise((resolve) => {
  const s = tls.connect({ host, port: ports.sink, servername: 'secure.test', ca, ...opts }, () => console.log(label, 'secureConnect'));
  s.write('sealed-placeholder ' + label + ' from ' + host + '\\n');
  s.on('error', (e) => console.log(label, 'error', e.code));
  s.on('close', () => resolve());
});
(async () => {
  await go('wrong name', {});
  await go('untrusted', { ca: undefined });
  await go('own check refuses', { servername: 'other.test', checkServerIdentity: () => Object.assign(new Error('not mine'), { code: 'MINE' }) });
})();
`,
      ports,
      { address: true }
    );
    assert.equal(host.status, 0, host.stderr);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
    assert.equal(shim.stdout, 'wrong name error ERR_TLS_CERT_ALTNAME_INVALID\nuntrusted error SELF_SIGNED_CERT_IN_CHAIN\nown check refuses error MINE\n');
    assert.deepEqual(sunk, []);
  });

  it("verification is Node's: the chain's error in OpenSSL's words, checkServerIdentity on the certificate, rejectUnauthorized: false, TLS 1.2, an RSA key, the issuer from the ca", async () => {
    const { host, shim } = await both(
      'verify.js',
      `const tls = require('tls');
const fs = require('fs');
const [host, portsJson, dir] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const ca = fs.readFileSync(dir + '/ca.pem');
const go = (label, opts) => new Promise((resolve) => {
  const s = tls.connect({ host, servername: 'secure.test', ca, ...opts }, () => {
    const c = s.getPeerCertificate(true);
    console.log(label, 'secureConnect', s.authorized, s.authorizationError, s.getProtocol(), c.subject.CN, c.issuerCertificate && c.issuerCertificate.subject.CN, c.issuerCertificate && c.issuerCertificate.issuerCertificate === c.issuerCertificate, c.bits, c.exponent, c.modulus && c.modulus.length, c.asn1Curve, c.pubkey.length);
    s.end('x');
  });
  s.on('data', (d) => console.log(label, 'data', String(d)));
  s.on('error', (e) => console.log(label, 'error', e.name, e.code, e.message, JSON.stringify(Object.keys(e)), e.reason, e.host, e.cert && e.cert.subject.CN));
  s.on('close', () => resolve());
});
(async () => {
  await go('untrusted', { port: ports.untrusted });
  await go('leaf only, untrusted', { port: ports.leafOnlyUntrusted });
  await go('self-signed', { port: ports.selfSigned });
  await go('expired', { port: ports.expired });
  await go('wrong name', { port: ports.wrongName });
  await go('no servername', { port: ports.wrongName, servername: undefined });
  await go('untrusted, rejectUnauthorized false', { port: ports.untrusted, rejectUnauthorized: false });
  await go('wrong name, rejectUnauthorized false', { port: ports.wrongName, rejectUnauthorized: false });
  await go('own check refuses', { port: ports.echo, checkServerIdentity: (h, c) => (console.log('check', h, c.subject.CN, typeof c.issuerCertificate), Object.assign(new Error('not mine'), { code: 'MINE' })) });
  await go('own check refuses a wrong name', { port: ports.wrongName, checkServerIdentity: (h, c) => (console.log('check', h, c.subject.CN), Object.assign(new Error('not mine'), { code: 'MINE' })) });
  await go('own check takes a wrong name', { port: ports.wrongName, checkServerIdentity: (h, c) => (console.log('check', h, c.subject.CN), undefined) });
  await go('leaf only, issuer from the ca', { port: ports.leafOnly });
  await go('TLS 1.2', { port: ports.tls12 });
  await go('RSA', { port: ports.rsa, ca: fs.readFileSync(dir + '/rsa.pem') });
  await go('secureContext ca', { port: ports.leafOnly, ca: undefined, secureContext: tls.createSecureContext({ ca }) });
  await go('hang-up', { port: ports.hangup });
})();
`,
      ports,
      { address: true }
    );
    assert.equal(host.status, 0, host.stderr);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
    assert.match(shim.stdout, /^wrong name error Error ERR_TLS_CERT_ALTNAME_INVALID Hostname\/IP does not match certificate's altnames: /m);
    assert.match(shim.stdout, /^check secure\.test other\.test\nown check refuses a wrong name error Error MINE not mine /m);
    assert.match(shim.stdout, /^own check takes a wrong name secureConnect true null TLSv1\.3 other\.test /m);
  });

  it("the chain's verdict is the kernel's (kernel 1.125.2): a self-issued certificate that isn't self-signed, and with another name a client-only certificate or a key usage no server may have", async () => {
    const { host, shim } = await both(
      'chain.js',
      `const tls = require('tls');
const fs = require('fs');
const [host, portsJson, dir] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const ca = fs.readFileSync(dir + '/ca.pem');
const go = (label, opts) => new Promise((resolve) => {
  const s = tls.connect({ host, servername: 'secure.test', ca, ...opts }, () => {
    console.log(label, 'secureConnect', s.authorized, s.authorizationError);
    s.end();
  });
  s.on('error', (e) => console.log(label, 'error', e.code, e.message, e.reason));
  s.on('close', () => resolve());
});
(async () => {
  await go('self-issued', { port: ports.selfIssued });
  await go('self-issued, rejectUnauthorized false', { port: ports.selfIssued, rejectUnauthorized: false });
  await go('client only, another name', { port: ports.clientOnlyWrongName });
  await go('client only, another name, rejectUnauthorized false', { port: ports.clientOnlyWrongName, rejectUnauthorized: false });
  await go('key usage, another name', { port: ports.badUsageWrongName });
  await go('key usage, another name, rejectUnauthorized false', { port: ports.badUsageWrongName, rejectUnauthorized: false });
})();
`,
      ports
    );
    assert.equal(host.status, 0, host.stderr);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
  });

  it('STARTTLS: tls.connect({ socket }) and new tls.TLSSocket(socket) upgrade a plain connection in place', async () => {
    const { host, shim } = await both(
      'starttls.js',
      `const tls = require('tls');
const net = require('net');
const fs = require('fs');
const [host, port, dir] = process.argv.slice(2);
const ca = fs.readFileSync(dir + '/ca.pem');
const plainThenTls = (label, upgrade) => new Promise((resolve) => {
  const plain = net.connect(Number(port), host, () => plain.write('STARTTLS\\r\\n'));
  plain.setEncoding('utf8');
  plain.on('end', () => console.log(label, 'plain end'));
  plain.on('close', () => console.log(label, 'plain close'));
  plain.once('data', (line) => {
    console.log(label, 'plain', line.trim());
    plain.on('data', (d) => console.log(label, 'plain data after the upgrade', d));
    const s = upgrade(plain);
    s.on('secure', () => console.log(label, 'secure', s.authorized, s.alpnProtocol, s.getProtocol(), s.encrypted));
    s.on('data', (d) => { console.log(label, 'echo', String(d)); s.end(); });
    s.on('end', () => console.log(label, 'tls end'));
    s.on('close', () => { console.log(label, 'tls close'); setTimeout(resolve, 20); });
    s.on('error', (e) => console.log(label, 'error', e.code, e.message));
  });
});
(async () => {
  await plainThenTls('tls.connect', (socket) => {
    const s = tls.connect({ socket, servername: 'secure.test', ca }, () => {
      console.log('tls.connect secureConnect', s.authorized, s.authorizationError, s.servername, s.getPeerCertificate().subject.CN);
      s.write('hello');
    });
    return s;
  });
  await plainThenTls('TLSSocket', (socket) => {
    const s = new tls.TLSSocket(socket, { isServer: false, servername: 'secure.test', secureContext: tls.createSecureContext({ ca }) });
    console.log('TLSSocket made', s.connecting, s.secureConnecting, s.authorized);
    s.write('bare');
    return s;
  });
  await plainThenTls('refused', (socket) => tls.connect({ socket, servername: 'other.test', ca }, () => console.log('no')));
})();
`,
      ports.starttls
    );
    assert.equal(host.status, 0, host.stderr);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
  });

  it('STARTTLS, then end(): the program lives until the plain socket closes, with nothing else to keep it (#730)', async () => {
    const { host, shim } = await both(
      'starttls-end.js',
      `const tls = require('tls');
const net = require('net');
const fs = require('fs');
const [host, port, dir] = process.argv.slice(2);
const ca = fs.readFileSync(dir + '/ca.pem');
const upgradeThenEnd = (label) => new Promise((resolve) => {
  const plain = net.connect(Number(port), host, () => plain.write('STARTTLS\\r\\n'));
  plain.on('end', () => console.log(label, 'plain end'));
  plain.on('close', (hadError) => {
    console.log(label, 'plain close', hadError);
    resolve();
  });
  plain.once('data', (line) => {
    console.log(label, 'plain', String(line).trim());
    const s = tls.connect({ socket: plain, servername: 'secure.test', ca }, () => {
      console.log(label, 'secureConnect', s.authorized);
      s.write(label);
    });
    s.once('data', (d) => {
      console.log(label, 'echo', String(d));
      s.end();
    });
    s.on('end', () => console.log(label, 'tls end'));
    s.on('close', (hadError) => console.log(label, 'tls close', hadError));
    s.on('error', (e) => console.log(label, 'error', e.code));
  });
});
process.on('exit', (code) => console.log('exit', code));
(async () => {
  for (const label of ['first', 'second', 'third']) {
    await upgradeThenEnd(label);
    console.log(label, 'done');
  }
})();
`,
      ports.starttls
    );
    assert.equal(host.status, 0, host.stderr);
    assert.match(host.stdout, /^third done$/m);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
    assert.equal(shim.status, host.status);
  });

  it("STARTTLS, then end(), with the plain socket's destroy callback held back: the program still lives until the plain socket closes (#814)", async () => {
    const { host, shim } = await both(
      'starttls-end-late.js',
      `const tls = require('tls');
const net = require('net');
const fs = require('fs');
const [host, port, dir] = process.argv.slice(2);
const ca = fs.readFileSync(dir + '/ca.pem');
const upgradeThenEnd = (label) => new Promise((resolve) => {
  const plain = net.connect(Number(port), host, () => plain.write('STARTTLS\\r\\n'));
  const destroy = plain._destroy;
  plain._destroy = function (err, cb) {
    return destroy.call(this, err, (e) => setTimeout(() => cb(e), 50).unref());
  };
  plain.on('close', (hadError) => {
    console.log(label, 'plain close', hadError);
    resolve();
  });
  plain.once('data', () => {
    const s = tls.connect({ socket: plain, servername: 'secure.test', ca }, () => s.write(label));
    s.once('data', (d) => {
      console.log(label, 'echo', String(d));
      s.end();
    });
    s.on('close', (hadError) => console.log(label, 'tls close', hadError));
    s.on('error', (e) => console.log(label, 'error', e.code));
  });
});
process.on('exit', (code) => console.log('exit', code));
(async () => {
  for (const label of ['first', 'second']) {
    await upgradeThenEnd(label);
    console.log(label, 'done');
  }
})();
`,
      ports.starttls
    );
    assert.equal(host.status, 0, host.stderr);
    assert.match(host.stdout, /^second done$/m);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
    assert.equal(shim.status, host.status);
  });

  it("end() before the handshake is done: what it carries goes out after it, straight and over STARTTLS, and a handshake that fails is the end callback's error (#838)", async () => {
    const { host, shim } = await both(
      'end-before-secure.js',
      `const tls = require('tls');
const net = require('net');
const fs = require('fs');
const [host, ports, dir] = process.argv.slice(2);
const port = JSON.parse(ports);
const ca = fs.readFileSync(dir + '/ca.pem');
const watch = (label, s, resolve) => {
  const seen = [];
  let got = '';
  for (const e of ['secureConnect', 'finish', 'end']) s.on(e, () => seen.push(e));
  s.on('data', (d) => (got += d));
  s.on('error', (e) => seen.push('error ' + e.code));
  s.on('close', () => {
    console.log(label, seen.join(', '), '| got', JSON.stringify(got));
    resolve();
  });
};
const direct = (label, use, p = port.echo) => new Promise((resolve) => {
  const s = tls.connect({ host, port: p, servername: 'secure.test', ca });
  watch(label, s, resolve);
  use(s);
});
const starttls = (label, upgrade) => new Promise((resolve) => {
  const plain = net.connect(port.starttls, host, () => plain.write('STARTTLS\\r\\n'));
  plain.once('data', () => {
    const s = upgrade(plain);
    watch(label, s, resolve);
    s.end('payload', (e) => console.log(label, 'end callback', e ? e.code : null));
  });
});
(async () => {
  await direct('end(payload)', (s) => s.end('payload', (e) => console.log('end(payload) end callback', e ? e.code : null)));
  await direct('write, end()', (s) => { s.write('a'); s.write('b'); s.end(); });
  await starttls('STARTTLS tls.connect end(payload)', (socket) => tls.connect({ socket, servername: 'secure.test', ca }));
  await starttls('STARTTLS TLSSocket end(payload)', (socket) => new tls.TLSSocket(socket, { isServer: false, servername: 'secure.test', secureContext: tls.createSecureContext({ ca }) }));
  await direct('an untrusted peer', (s) => s.end('payload', (e) => console.log('an untrusted peer end callback', e ? e.code : null)), port.untrusted);
})();
`,
      { echo: ports.echo, starttls: ports.starttls, untrusted: ports.untrusted }
    );
    assert.equal(host.status, 0, host.stderr);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
  });

  it("a TLS socket nobody reads keeps what arrives, with readableFlowing null and no 'end', until the program reads it (#834)", async () => {
    const { host, shim } = await both(
      'tls-unread.js',
      `const tls = require('tls');
const fs = require('fs');
const [host, port, dir] = process.argv.slice(2);
const ca = fs.readFileSync(dir + '/ca.pem');
const open = (label) => {
  const s = tls.connect({ host, port: Number(port), servername: 'secure.test', ca });
  let ended = false;
  s.on('end', () => (ended = true));
  return { s, state: () => label + ' readableFlowing ' + s.readableFlowing + ', readableLength ' + s.readableLength + ', ended ' + ended };
};
(async () => {
  const late = open('late');
  await new Promise((r) => late.s.once('secureConnect', r));
  await new Promise((r) => setTimeout(r, 200));
  console.log(late.state());
  let got = '';
  late.s.on('data', (d) => (got += d));
  await new Promise((r) => late.s.on('end', r));
  console.log('late got', JSON.stringify(got));
  late.s.destroy();
  const never = open('never');
  await new Promise((r) => never.s.once('secureConnect', r));
  await new Promise((r) => setTimeout(r, 200));
  console.log(never.state());
  process.on('exit', (code) => console.log(never.state(), 'exit', code));
})();
`,
      ports.hello
    );
    assert.equal(host.status, 0, host.stderr);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
  });

  it('the real pg: an SSLRequest, then TLS over the same socket (sslmode=verify-full with sslrootcert, and libpq-style require)', async () => {
    const { host, shim } = await both(
      'pg.js',
      `const [host, portsJson, dir, mods] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const { Client } = require(mods + '/pg');
const run = async (label, url) => {
  const c = new Client({ connectionString: url });
  try {
    await c.connect();
    const s = c.connection.stream;
    const r = await c.query('select 1');
    console.log(label, JSON.stringify(r.rows), s.encrypted, s.authorized, s.authorizationError, s.getProtocol(), c.connection.stream.getPeerCertificate().subject.CN);
    await c.end();
  } catch (e) {
    console.log(label, 'error', e.code, e.message);
  }
};
(async () => {
  await run('verify-full', 'postgres://alice@' + host + ':' + ports.pg + '/db?sslmode=verify-full&sslrootcert=' + dir + '/ca.pem');
  await run('require (libpq)', 'postgres://alice@' + host + ':' + ports.pgUntrusted + '/db?sslmode=require&uselibpqcompat=true');
  await run('verify-full, untrusted', 'postgres://alice@' + host + ':' + ports.pgUntrusted + '/db?sslmode=verify-full&sslrootcert=' + dir + '/ca.pem');
})();
`,
      ports
    );
    assert.equal(host.status, 0, host.stderr);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
    assert.match(shim.stdout, /^verify-full \[\{"answer":"over TLSv1\.3: select 1"\}\] true true null TLSv1\.3 db\.test$/m);
  });

  it('the real nodemailer: STARTTLS on a submission port and TLS from the start (SMTPS), to a real SMTP server', async () => {
    mail.length = 0;
    const { host, shim } = await both(
      'mail.js',
      `const [host, portsJson, dir, mods] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const fs = require('fs');
const nodemailer = require(mods + '/nodemailer');
const ca = fs.readFileSync(dir + '/ca.pem');
const send = async (label, options, extra = {}) => {
  const t = nodemailer.createTransport({ host, name: 'client.test', tls: { ca, servername: 'mail.test' }, ...options });
  try {
    await t.verify();
    const info = await t.sendMail({ from: 'a@client.test', to: 'b@mail.test', subject: label + ' via ' + (process.versions.node.split('.')[0]), text: 'hi', ...extra });
    console.log(label, info.response, JSON.stringify(info.accepted), JSON.stringify(info.envelope));
  } catch (e) {
    console.log(label, 'error', e.code, e.message);
  }
  t.close();
};
(async () => {
  await send('starttls', { port: ports.smtp, secure: false, requireTLS: true });
  await send('smtps', { port: ports.smtps, secure: true });
  await send('starttls, wrong name', { port: ports.smtp, secure: false, requireTLS: true, tls: { ca, servername: 'other.test' } });
})();
`,
      ports
    );
    assert.equal(host.status, 0, host.stderr);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
    assert.match(shim.stdout, /^starttls 250 OK: message queued \["b@mail\.test"\]/m);
    assert.deepEqual(mail.sort(), [
      'smtp secure=true from=a@client.test subject=starttls via 22',
      'smtp secure=true from=a@client.test subject=starttls via 22',
      'smtps secure=true from=a@client.test subject=smtps via 22',
      'smtps secure=true from=a@client.test subject=smtps via 22',
    ]);
  });

  it('the real https-proxy-agent: CONNECT through a proxy, then TLS to the server over the tunnel', async () => {
    connects.length = 0;
    const { host, shim } = await both(
      'proxied.js',
      `const [host, portsJson, dir, mods] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const fs = require('fs');
const https = require('https');
const { pathToFileURL } = require('url');
(async () => {
  const { HttpsProxyAgent } = await import(pathToFileURL(mods + '/https-proxy-agent/dist/index.js').href);
  const agent = new HttpsProxyAgent('http://' + host + ':' + ports.proxy);
  const ca = fs.readFileSync(dir + '/ca.pem');
  const get = (path, extra = {}) => new Promise((resolve) => {
    const req = https.get('https://secure.test:' + ports.https + path, { agent, ca, ...extra }, (res) => {
      const socket = res.socket;
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve([res.statusCode, body, res.headers['x-seen-host'].replace(/\\d+$/, 'PORT'), socket.encrypted, socket.authorized, socket.servername, socket.getPeerCertificate().subject.CN].join(' ')));
    });
    req.on('error', (e) => resolve('error ' + e.code + ' ' + e.message));
  });
  console.log(await get('/through'));
  console.log(await get('/untrusted', { ca: undefined }));
})();
`,
      ports
    );
    assert.equal(host.status, 0, host.stderr);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
    assert.equal(shim.status, 0, shim.stderr);
    assert.match(shim.stdout, /^200 GET \/through secure\.test:PORT true true secure\.test secure\.test$/m);
    assert.deepEqual(connects, Array(4).fill('secure.test:PORT'));
  });

  it('https.request over these sockets: an agent with keep-alive, trailers, header case, and a ca without an agent', async () => {
    const { host, shim } = await both(
      'https.js',
      `const [host, portsJson, dir, mods] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const fs = require('fs');
const https = require('https');
const ca = fs.readFileSync(dir + '/ca.pem');
const send = (label, options, body) => new Promise((resolve) => {
  const req = https.request({ host, port: ports.https, ...options }, (res) => {
    const socket = res.socket;
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (b += c));
    res.on('end', () => {
      console.log(label, res.statusCode, JSON.stringify(res.rawHeaders.map((h) => h.replace(/:\\d+$/, ':PORT'))), JSON.stringify(b), JSON.stringify(res.rawTrailers), req.reusedSocket, socket.encrypted, socket.authorized, socket.getProtocol());
      resolve();
    });
  });
  req.on('error', (e) => { console.log(label, 'error', e.code, e.message); resolve(); });
  req.end(body);
});
(async () => {
  const agent = new https.Agent({ keepAlive: true, ca });
  await send('first', { path: '/a', agent, servername: 'secure.test', headers: { 'X-Mixed-Case': 'one' } });
  await send('reused', { path: '/b', method: 'POST', agent, servername: 'secure.test', headers: { 'Content-Length': 4 } }, 'body');
  await send('trailers', { path: '/trailers', agent, servername: 'secure.test' });
  await send('host header names the server', { path: '/c', agent, headers: { Host: 'secure.test' } });
  await send('no agent, a ca', { path: '/d', ca, servername: 'secure.test' });
  await send('no agent, wrong name', { path: '/e', ca, servername: 'other.test' });
  await send('no agent, wrong name, own check refuses', { path: '/e', ca, servername: 'other.test', checkServerIdentity: (h, c) => (console.log('check', h, c.subject.CN), Object.assign(new Error('not mine'), { code: 'MINE' })) });
  await send('no agent, wrong name, own check takes it', { path: '/e', ca, servername: 'other.test', checkServerIdentity: (h, c) => (console.log('check', h, c.subject.CN), undefined) });
  await send('agent: false, a ca', { path: '/f', ca, servername: 'secure.test', agent: false });
  console.log('free', Object.keys(agent.freeSockets).length);
  agent.destroy();
})();
`,
      ports,
      { address: true }
    );
    assert.equal(host.status, 0, host.stderr);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
    assert.match(shim.stdout, /^no agent, wrong name error ERR_TLS_CERT_ALTNAME_INVALID Hostname\/IP does not match certificate's altnames: Host: other\.test\. /m);
    assert.match(shim.stdout, /^check other\.test secure\.test\nno agent, wrong name, own check refuses error MINE not mine$/m);
    assert.match(shim.stdout, /^check other\.test secure\.test\nno agent, wrong name, own check takes it 200 /m);
  });

  it('client certificates (kernel 1.124.13): mTLS on TLS 1.3 and 1.2, an encrypted key, getCertificate, and a server that requires one', async () => {
    const { host, shim } = await both(
      'mtls.js',
      `const tls = require('tls');
const fs = require('fs');
const [host, portsJson, dir] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const ca = fs.readFileSync(dir + '/ca.pem');
const cert = fs.readFileSync(dir + '/client.pem');
const key = fs.readFileSync(dir + '/client.key', 'utf8');
const encrypted = fs.readFileSync(dir + '/client-enc.key');
const go = (label, opts) => new Promise((resolve) => {
  const s = tls.connect({ host, servername: 'secure.test', ca, ...opts }, () => {
    const c = s.getCertificate();
    console.log(label, 'secureConnect', s.authorized, s.getProtocol(), Object.keys(c).join(), c.subject && c.subject.CN, c.issuer && c.issuer.CN, c.ext_key_usage, c.raw && c.raw.length, c.fingerprint256 === (c.raw && require('crypto').createHash('sha256').update(c.raw).digest('hex').toUpperCase().match(/../g).join(':')));
  });
  s.setEncoding('utf8');
  s.on('data', (d) => console.log(label, 'data', d));
  // Node's message starts with its thread's id: the code, and what the error has.
  s.on('error', (e) => console.log(label, 'error', e.name, e.code, e.library, e.reason === e.code.slice(8).toLowerCase().replaceAll('_', ' '), Object.keys(e).join()));
  s.on('close', () => resolve());
});
(async () => {
  await go('TLS 1.3', { port: ports.mtls, cert, key });
  await go('TLS 1.2', { port: ports.mtls12, cert, key });
  await go('encrypted key', { port: ports.mtls, cert, key: encrypted, passphrase: 'pw' });
  await go('key as { pem, passphrase }', { port: ports.mtls, cert, key: [{ pem: encrypted, passphrase: 'pw' }] });
  await go('secureContext', { port: ports.mtls, ca: undefined, secureContext: tls.createSecureContext({ ca, cert, key }) });
  await go('not asked for', { port: ports.sni, cert, key });
  await go('none, TLS 1.3', { port: ports.mtls });
  await go('none, TLS 1.2', { port: ports.mtls12 });
  await go('a certificate without its key', { port: ports.mtls, cert });
  await go('a key without its certificate', { port: ports.mtls12, key });
})();
`,
      ports
    );
    assert.equal(host.status, 0, host.stderr);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
    assert.match(shim.stdout, /^TLS 1\.3 data client=client\.test sni=secure\.test$/m);
    assert.match(shim.stdout, /^TLS 1\.2 data client=client\.test sni=secure\.test$/m);
  });

  it("bad key material: Node's codes, messages and properties for a wrong or missing passphrase, a key that isn't one, another certificate's key, a certificate that isn't one", async () => {
    // Node throws these from tls.connect (createSecureContext); jsh throws
    // what it can see without the kernel (it isn't one, the certificate isn't
    // one, a wrong passphrase), and another certificate's key is the kernel's at connect, on 'error'.
    const { host, shim } = await both(
      'badkey.js',
      `const tls = require('tls');
const fs = require('fs');
const [host, portsJson, dir] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const ca = fs.readFileSync(dir + '/ca.pem');
const cert = fs.readFileSync(dir + '/client.pem', 'utf8');
const key = fs.readFileSync(dir + '/client.key');
const locked = fs.readFileSync(dir + '/locked.key', 'utf8');
const show = (label, e) => console.log(label, e.name, e.code, e.message, JSON.stringify(Object.entries(e)));
const go = (label, opts) => new Promise((resolve) => {
  let s;
  try {
    s = tls.connect({ host, port: ports.mtls, servername: 'secure.test', ca, ...opts }, () => console.log(label, 'secureConnect'));
  } catch (e) {
    show(label, e);
    return resolve();
  }
  s.on('connect', () => console.log(label, 'connect'));
  s.on('error', (e) => show(label, e));
  s.on('close', () => resolve());
});
(async () => {
  await go('wrong passphrase', { cert, key: locked, passphrase: 'not it' });
  await go('no passphrase', { cert, key: locked });
  await go('not a key', { cert, key: 'garbage' });
  await go('a certificate as the key', { cert, key: cert });
  await go("another certificate's key", { cert, key: fs.readFileSync(dir + '/other.key') });
  await go('not a certificate', { cert: 'nope', key });
  for (const [label, o] of [['context, not a key', { cert, key: Buffer.from('garbage') }], ['context, not a certificate', { cert: Buffer.from('nope'), key }], ['context, key type', { key: 42 }], ['context, passphrase type', { key, passphrase: 7 }]]) {
    try {
      tls.createSecureContext(o);
      console.log(label, 'made');
    } catch (e) {
      show(label, e);
    }
  }
})();
`,
      ports
    );
    assert.equal(host.status, 0, host.stderr);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
    // pfx is the kernel's ENOTSUP: no PKCS#12 in the engine.
    const pfx = await jsh.run(['node', '-e', "try { require('tls').connect({ host: '203.0.113.10', port: 1, pfx: Buffer.from('x') }) } catch (e) { console.log(e.code, e.message) }"]);
    assert.equal(pfx.stdout, "ERR_NOT_SUPPORTED slicc-jsh: 'tls.createSecureContext option 'pfx'' is not supported yet (no TLS on ctx.net)\n");
  });

  it('SNI as Node sends it (only a servername tls.connect is given), getCipher, and checkServerIdentity on the leaf', async () => {
    const { host, shim } = await both(
      'sni.js',
      `const tls = require('tls');
const net = require('net');
const fs = require('fs');
const [host, portsJson, dir] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const ca = fs.readFileSync(dir + '/ca.pem');
// Node resolves secure.test with this; jsh through the kernel (the uplink's name).
const lookup = (name, o, cb) => (o && o.all ? cb(null, [{ address: host, family: 4 }]) : cb(null, host, 4));
const go = (label, opts) => new Promise((resolve) => {
  const s = tls.connect({ ca, ...opts }, () => console.log(label, 'secureConnect', s.authorized, s.authorizationError, JSON.stringify(s.servername), JSON.stringify(s.getCipher())));
  s.setEncoding('utf8');
  s.on('data', (d) => console.log(label, 'data', d));
  s.on('error', (e) => console.log(label, 'error', e.code, e.message));
  s.on('close', () => resolve());
});
const upgraded = (label, upgrade) => new Promise((resolve) => {
  const plain = net.connect(ports.starttlsSni, host, () => plain.write('STARTTLS\\r\\n'));
  plain.once('data', () => {
    const s = upgrade(plain);
    s.setEncoding('utf8');
    s.on('data', (d) => console.log(label, 'data', d, JSON.stringify(s.servername)));
    s.on('error', (e) => console.log(label, 'error', e.code));
    s.on('close', () => resolve());
  });
});
const own = (h, c) => {
  console.log('check', h, c.subject.CN, c.issuerCertificate.subject.CN, c.serialNumber === leafSerial, Buffer.isBuffer(c.raw));
};
let leafSerial;
(async () => {
  await go('a hostname', { host: 'secure.test', port: ports.sni, lookup });
  await go('an IP', { host, port: ports.sni });
  await go('servername', { host, port: ports.sni, servername: 'secure.test' });
  await go("servername ''", { host: 'secure.test', port: ports.sni, servername: '', lookup });
  await go('TLS 1.3 suite', { host, port: ports.cipher13, servername: 'secure.test' });
  await go('TLS 1.2 suite', { host, port: ports.cipher12, servername: 'secure.test' });
  await upgraded('over a socket, servername', (socket) => tls.connect({ socket, servername: 'secure.test', ca }));
  await upgraded('over a socket, host', (socket) => tls.connect({ socket, host: 'secure.test', ca }));
  await upgraded('a TLSSocket with a servername', (socket) => {
    const s = new tls.TLSSocket(socket, { servername: 'secure.test' });
    s.write('x');
    return s;
  });
  await new Promise((resolve) => {
    const s = tls.connect({ host, port: ports.sni, servername: 'secure.test', ca }, () => {
      leafSerial = s.getPeerCertificate().serialNumber;
      s.destroy();
    });
    s.on('close', resolve);
  });
  await go('own check, the leaf', { host, port: ports.sni, servername: 'secure.test', checkServerIdentity: (h, c) => own(h, c) });
  await go('own check, by host', { host: 'secure.test', port: ports.sni, lookup, checkServerIdentity: (h, c) => own(h, c) });
  await go('a secureContext of its own', { host, port: ports.sni, servername: 'secure.test', ca: undefined, secureContext: tls.createSecureContext({ ca }) });
  await go('own check returns an error', { host, port: ports.sni, servername: 'secure.test', checkServerIdentity: (h, c) => (own(h, c), new Error('not this one')) });
  await go('own check returns an error, rejectUnauthorized false', { host, port: ports.sni, servername: 'secure.test', rejectUnauthorized: false, checkServerIdentity: (h, c) => (own(h, c), Object.assign(new Error('not this one'), { code: 'MINE' })) });
  await go("Node's check, rejectUnauthorized false, a wrong name", { host, port: ports.sni, servername: 'other.test', rejectUnauthorized: false });
  process.on('uncaughtException', (e) => {
    console.log('uncaught', e.message);
    process.exit(0);
  });
  await upgraded('over a socket, own check throws', (socket) => {
    const s = tls.connect({ socket, servername: 'secure.test', ca, checkServerIdentity: (h, c) => { own(h, c); throw new Error('thrown over a socket'); } });
    s.on('secure', () => console.log('secure listener ran'));
    return s;
  });
  console.log('not reached');
})();
`,
      ports
    );
    assert.equal(host.status, 0, host.stderr);
    assert.equal(shim.stdout, host.stdout);
    assert.equal(shim.stderr, '');
    assert.equal(shim.status, 0);
    assert.match(shim.stdout, /^a hostname data client=none sni=false$/m);
    assert.match(shim.stdout, /^servername data client=none sni=secure\.test$/m);
    assert.match(shim.stdout, /^TLS 1\.2 suite secureConnect true null "secure\.test" \{"name":"ECDHE-ECDSA-AES256-GCM-SHA384","standardName":"TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384","version":"TLSv1\.2"\}$/m);
    assert.match(shim.stdout, /^uncaught thrown over a socket$/m);
    assert.doesNotMatch(shim.stdout, /secure listener ran/);
    // The same throw from a tls.connect of its own: later 'secure' listeners don't run.
    const thrown = await both(
      'throws.js',
      `const tls = require('tls');
const fs = require('fs');
const [host, portsJson, dir] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
process.on('uncaughtException', (e) => {
  console.log('uncaught', e.message);
  process.exit(0);
});
const s = tls.connect({ host, port: ports.sni, servername: 'secure.test', ca: fs.readFileSync(dir + '/ca.pem'), checkServerIdentity: (h, c) => { console.log('check', h, c.subject.CN); throw new Error('thrown'); } }, () => console.log('secureConnect'));
s.on('secure', () => console.log('secure listener ran'));
s.on('error', (e) => console.log('error', e.message));
`,
      ports
    );
    assert.equal(thrown.host.status, 0, thrown.host.stderr);
    assert.equal(thrown.shim.stdout, thrown.host.stdout);
    assert.equal(thrown.shim.stdout, 'check secure.test secure.test\nuncaught thrown\n');
  });

  it('client certificates in the real pg (sslcert, sslkey) and in https.request, with an agent and without', async () => {
    const { host, shim } = await both(
      'mtls-clients.js',
      `const [host, portsJson, dir, mods] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const fs = require('fs');
const https = require('https');
const { Client } = require(mods + '/pg');
const ca = fs.readFileSync(dir + '/ca.pem');
const cert = fs.readFileSync(dir + '/client.pem');
const key = fs.readFileSync(dir + '/client.key');
const pg = async (label, url) => {
  const c = new Client({ connectionString: url });
  try {
    await c.connect();
    const r = await c.query('select 1');
    console.log(label, JSON.stringify(r.rows), c.connection.stream.getCertificate().subject.CN);
    await c.end();
  } catch (e) {
    console.log(label, 'error', e.code);
  }
};
const get = (label, options) => new Promise((resolve) => {
  const req = https.request({ host, port: ports.mtlsHttps, servername: 'secure.test', ca, ...options }, (res) => {
    const socket = res.socket;
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (b += c));
    res.on('end', () => {
      console.log(label, res.statusCode, b, socket.getCertificate().subject.CN);
      resolve();
    });
  });
  req.on('error', (e) => {
    console.log(label, 'error', e.code);
    resolve();
  });
  req.end();
});
(async () => {
  const base = 'postgres://alice@' + host + ':' + ports.pgMtls + '/db?sslmode=verify-full&sslrootcert=' + dir + '/ca.pem';
  await pg('pg, sslcert and sslkey', base + '&sslcert=' + dir + '/client.pem&sslkey=' + dir + '/client.key');
  await pg('pg, no certificate', 'postgres://alice@' + host + ':' + ports.pgMtls + '/db');
  const agent = new https.Agent({ keepAlive: true, cert, key });
  await get('agent', { path: '/agent', agent });
  await get('agent again', { path: '/again', agent });
  await get('request options', { path: '/request', cert, key, agent: false });
  await get('globalAgent', { path: '/global', cert, key });
  await get('secureContext only', { path: '/context', ca: undefined, secureContext: require('tls').createSecureContext({ ca, cert, key }) });
  console.log('free', Object.keys(agent.freeSockets).length);
  agent.destroy();
  // Thrown from https.get itself, as Node's agent connects inside it.
  for (const [label, o] of [['not a certificate', { cert: 'x', key: 'y' }], ['not a key', { cert, key: 'garbage' }], ['not a key, an agent', { cert, key: 'garbage', agent: new https.Agent() }]]) {
    try {
      const req = https.get({ host, port: ports.mtlsHttps, servername: 'secure.test', ca, ...o }, () => console.log(label, 'response'));
      req.on('error', (e) => console.log(label, 'error event', e.code));
      console.log(label, 'returned');
    } catch (e) {
      console.log(label, 'threw', e.code, e.message);
    }
  }
  // A createConnection of the caller's gets cert and key as given, unparsed.
  let seen;
  try {
    const req = https.get({ host, port: ports.mtlsHttps, cert: 'token', key: 'opaque', createConnection: (o) => {
      seen = [o.cert, o.key];
      const s = new (require('net').Socket)();
      process.nextTick(() => s.destroy());
      return s;
    } });
    req.on('error', () => {});
  } catch (e) {
    console.log('own createConnection threw', e.code);
  }
  await new Promise((r) => setTimeout(r, 100));
  console.log('own createConnection got', JSON.stringify(seen));
})();
`,
      ports
    );
    assert.equal(host.status, 0, host.stderr);
    assert.equal(shim.stdout, host.stdout);
    assert.match(shim.stdout, /^not a certificate threw ERR_OSSL_PEM_NO_START_LINE /m);
    assert.equal(shim.stderr, '');
    assert.match(shim.stdout, /^pg, sslcert and sslkey \[\{"answer":"over TLSv1\.3 as client\.test: select 1"\}\] client\.test$/m);
    assert.match(shim.stdout, /^agent 200 client=client\.test sni=secure\.test \/agent client\.test$/m);
  });
});
