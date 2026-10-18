import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createTcp, connect as tcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { devPackageTree, kernelAtLeast, withJsh } from './helpers.mjs';
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
const skip = !kernelAtLeast('1.124.0') && 'slicc-kernel before 1.124.0 has no TLS handshake of its own';

const UPLINK = '203.0.113.10';

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

describe('tls through the kernel handshake (kernel 1.124.0)', { skip }, () => {
  let jsh;
  let dir;
  const ca = makeCa();
  const servers = [];
  const peers = {};
  const ports = {};
  let rsaPem;
  const mail = [];
  const connects = [];

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
    const other = makeCa('another CA');
    const day = 86400_000;
    const plainLeaf = ca.server('secure.test');
    await tlsServer('untrusted', other.server('secure.test'));
    const otherLeaf = other.server('secure.test');
    await tlsServer('leafOnlyUntrusted', { key: otherLeaf.key, cert: otherLeaf.leafOnly });
    await tlsServer('selfSigned', selfSigned('secure.test'));
    await tlsServer('expired', ca.server('secure.test', { notBefore: new Date(Date.now() - 3 * day), notAfter: new Date(Date.now() - day) }));
    await tlsServer('wrongName', ca.server('other.test'));
    await tlsServer('leafOnly', { key: plainLeaf.key, cert: plainLeaf.leafOnly });
    const rsa = makeCa('RSA CA', { rsa: true });
    writeFileSync(join(dir, 'rsa.pem'), rsa.pem);
    rsaPem = rsa.pem;
    await tlsServer('rsa', rsa.server('secure.test', { rsa: true }));
    await tlsServer('tls12', { ...plainLeaf, maxVersion: 'TLSv1.2' });
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
    const pgServer = (leafFor) =>
      createTcp((sock) => {
        sock.once('data', (d) => {
          if (d.length !== 8 || d.readInt32BE(4) !== 80877103) return sock.destroy();
          sock.write('S');
          const secure = new TLSSocket(sock, { isServer: true, key: leafFor.key, cert: leafFor.cert });
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
              const value = Buffer.from(`over ${secure.getProtocol()}: ${sql}`);
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
    for (const [name, leafFor] of [['pg', dbLeaf], ['pgUntrusted', other.server('db.test')]]) {
      const server = pgServer(leafFor);
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
    for (const port of Object.values(ports)) peers[`${UPLINK}:${port}`] = pipeTo(port);
    const { fakeUplink } = await import('@ai-ecoverse/slicc-kernel/testing');
    jsh = await withJsh({ uplink: fakeUplink({ routes: { prefixes: [], exit: true }, peers }), tlsEngine: true });
    for (const name of ['pg', 'nodemailer', 'https-proxy-agent']) {
      for (const [path, data] of devPackageTree(name)) await jsh.kernel.writeFile(`/os${path}`, data);
    }
    await jsh.kernel.writeFile('/os/ca.pem', ca.pem);
    await jsh.kernel.writeFile('/os/rsa.pem', rsaPem);
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
});
