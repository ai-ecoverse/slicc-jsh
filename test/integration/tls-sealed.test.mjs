import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcp, connect as tcp } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { TLSSocket } from 'node:tls';
import { devPackageTree, kernelAtLeast, withJsh } from './helpers.mjs';
import { makeCa } from './tls-certs.mjs';

// Sealed (vault) values on jsh's own TLS path: the kernel's handshake (A2),
// which jsh takes on any port but 443, and on 443 for a ca, a client
// certificate or a check of the program's own. slicc-kernel#1090 substitutes
// a sealed placeholder there only in a session the kernel verified itself
// (conn.tls.verified, slicc-kernel 1.126.0): the chain against its bundled
// roots, never a ca the program passed, and the leaf naming the servername,
// whatever the program's rejectUnauthorized or checkServerIdentity. It does
// so only after a STARTTLS upgrade, and only at a protocol's credential
// position (an HTTP/1.1 Authorization header, SMTP AUTH PLAIN and LOGIN,
// pg's cleartext PasswordMessage), so a verified server that echoes its input
// can't hand the secret back.
//
// The test kernel's bundled roots are the test CA (the engine package's
// roots.der), so its servers verify as a public server would, and its uplink
// says which exit a connection leaves by (tailscale), which substitution
// needs.
//
// Each row is what a server receives and what the program sees. The program
// must never see the secret, whatever the server does with it.
//
// Each protocol's rows run from the release that substitutes in it.
const SEALED = {
  http1: '1.127.0', // slicc-kernel#1130: an HTTP/1.1 request head's header, and the read scrub
  smtp: '1.129.0', // #1131: SMTP AUTH PLAIN and LOGIN's password, STARTTLS included
  pg: '1.131.0', // #1136: pg's cleartext PasswordMessage
};
const skipFor = (protocol) =>
  !(SEALED[protocol] && kernelAtLeast(SEALED[protocol])) && `slicc-kernel#1090 doesn't substitute in ${protocol} yet`;
const skip = !kernelAtLeast('1.127.0') && 'slicc-kernel before 1.127.0 substitutes in no A2 session';

// A placeholder as the vault makes them (fnox_proxy_<24 hex>).
const PLACEHOLDER = 'fnox_proxy_0123456789abcdef01234567';
const SECRET = 'jsh-1090-the-sealed-secret';
// The host each protocol's secret is bound to, and the positions it may go to.
const BINDINGS = [
  { host: 'api.test', protocol: 'http1', positions: ['header:authorization'] },
  { host: 'mail.test', protocol: 'smtp', positions: ['auth-plain', 'auth-login'] },
  { host: 'db.test', protocol: 'pg', positions: ['password-cleartext'] },
];
const BOUND = { api: 'api.test', mail: 'mail.test', db: 'db.test' };

/**
 * The vault: PLACEHOLDER stands for SECRET, bound per BINDINGS. The kernel
 * asks it once per session it verified itself (slicc-kernel 1.126.0's
 * README): `{ v: 1, op: 'sessionMaterialize', caller, stamp, session, host,
 * port, protocol, position, verified, handshakeAt, exit, placeholders,
 * head? }`, answered `{ values }`. A placeholder that isn't answered goes out
 * as written. `asked` is what was asked, once per host, protocol and position.
 */
function vault() {
  const asked = new Set();
  const hook = async (req) => {
    if (req?.op !== 'sessionMaterialize') return { v: 1, error: { code: 'EINVAL' } };
    assert.equal(req.verified, true, 'the kernel asks only for a session it verified');
    asked.add(`${req.host} ${req.protocol} ${req.position}`);
    const bound = BINDINGS.some((b) => b.host === req.host && b.protocol === req.protocol && b.positions.includes(req.position));
    return { values: bound && req.placeholders?.includes(PLACEHOLDER) ? { [PLACEHOLDER]: SECRET } : {} };
  };
  return { asked, hook };
}

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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address ? server : server.server).address().port)));
}

describe('sealed values in the kernel\'s TLS sessions (slicc-kernel#1090)', { skip }, () => {
  let jsh;
  let sealed;
  const ca = makeCa();
  const other = makeCa('another CA');
  const servers = [];
  const ports = {};
  // What each server was given, as [server, what, value].
  const got = [];
  const sawSecret = () => got.some((g) => String(g[2]).includes(SECRET));
  const gotFrom = (server) => got.filter((g) => g[0] === server).map((g) => `${g[1]} ${g[2]}`);

  before(async () => {
    const names = {};
    const peers = {};
    let n = 30;
    /** A server on the host, reached from the kernel as `name` at its own address. */
    const route = (name, port) => {
      const ip = `203.0.113.${n++}`;
      names[name] = [ip];
      peers[`${ip}:${port}`] = pipeTo(port);
    };
    // HTTP/1.1 over TLS on a port that isn't 443: the Authorization header,
    // and the body. /echo reflects the header.
    const httpsServer = async (label, leaf) => {
      const server = createHttpsServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          got.push([label, 'authorization', req.headers.authorization]);
          if (body) got.push([label, 'body', body]);
          res.end(req.url === '/echo' ? `you sent ${req.headers.authorization}` : 'ok');
        });
      });
      server.on('tlsClientError', () => {});
      servers.push(server);
      return listen(server);
    };
    ports.api = await httpsServer('api', ca.server(BOUND.api));
    route(BOUND.api, ports.api);
    ports.otherApi = await httpsServer('other-api', ca.server('other-api.test'));
    route('other-api.test', ports.otherApi);
    ports.untrusted = await httpsServer('untrusted', other.server(BOUND.api));
    route('untrusted.test', ports.untrusted);
    ports.mismatch = await httpsServer('mismatch', ca.server('other.test'));
    route('mismatch.test', ports.mismatch);

    // SMTP: STARTTLS on a submission port (AUTH allowed before it too, for
    // the plaintext row) and SMTPS. A user named `reflect` is refused with
    // the password quoted.
    const { SMTPServer } = await import('smtp-server');
    const mailLeaf = ca.server(BOUND.mail);
    for (const [label, secure] of [['smtp', false], ['smtps', true]]) {
      const smtp = new SMTPServer({
        secure,
        key: mailLeaf.key,
        cert: mailLeaf.cert,
        name: BOUND.mail,
        authMethods: ['PLAIN', 'LOGIN'],
        allowInsecureAuth: true,
        logger: false,
        onAuth(auth, session, cb) {
          got.push([label, `${auth.method}${session.secure ? ' secure' : ' plain'}`, auth.password]);
          if (auth.username === 'reflect') return cb(new Error(`bad password ${auth.password}`));
          cb(null, { user: auth.username });
        },
        onData(stream, session, cb) {
          stream.resume();
          stream.on('end', () => cb());
        },
      });
      smtp.on('error', () => {});
      servers.push(smtp);
      ports[label] = await listen(smtp);
    }
    route(BOUND.mail, ports.smtp);
    // SMTPS answers at its own address under another name.
    route('smtps.mail.test', ports.smtps);

    // pg: SSLRequest, TLS (or plaintext after 'N' for sslmode=disable), then
    // cleartext password authentication. A user named `reflect` is refused
    // with the password quoted.
    const dbLeaf = ca.server(BOUND.db);
    const pgServer = (label, leaf) =>
      createTcp((sock) => {
        const int32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
        const cstr = (t) => Buffer.from(`${t}\0`);
        const msg = (type, body) => Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
        const speak = (s) => {
          let buf = Buffer.alloc(0);
          let user;
          let state = 'startup';
          s.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            for (;;) {
              if (state === 'startup') {
                if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
                const len = buf.readInt32BE(0);
                const params = buf.subarray(8, len).toString().split('\0');
                buf = buf.subarray(len);
                user = params[params.indexOf('user') + 1];
                s.write(msg('R', int32(3)));
                state = 'password';
                continue;
              }
              if (buf.length < 5 || buf.length < 1 + buf.readInt32BE(1)) return;
              const type = String.fromCharCode(buf[0]);
              const len = buf.readInt32BE(1);
              const body = buf.subarray(5, 1 + len);
              buf = buf.subarray(1 + len);
              if (state === 'password' && type === 'p') {
                const password = body.subarray(0, body.length - 1).toString();
                got.push([label, `password${s.encrypted ? ' tls' : ' plain'}`, password]);
                if (user === 'reflect') {
                  s.end(msg('E', Buffer.concat([cstr('SFATAL'), cstr('C28P01'), cstr(`Mpassword authentication failed: ${password}`), Buffer.from('\0')])));
                  return;
                }
                s.write(Buffer.concat([msg('R', int32(0)), msg('K', Buffer.concat([int32(1), int32(2)])), msg('Z', Buffer.from('I'))]));
                state = 'ready';
                continue;
              }
              if (type === 'X') return s.end();
              if (type === 'Q') {
                s.write(Buffer.concat([msg('C', cstr('SELECT 0')), msg('Z', Buffer.from('I'))]));
              }
            }
          });
        };
        sock.once('data', (d) => {
          if (d.length !== 8 || d.readInt32BE(4) !== 80877103) {
            // No SSLRequest (sslmode=disable): the startup message itself.
            sock.unshift(d);
            return speak(sock);
          }
          sock.write('S');
          const secure = new TLSSocket(sock, { isServer: true, key: leaf.key, cert: leaf.cert });
          secure.on('error', () => {});
          speak(secure);
        });
      });
    for (const [label, leaf, name] of [['pg', dbLeaf, BOUND.db], ['pgUntrusted', other.server(BOUND.db), 'untrusted-db.test']]) {
      const server = pgServer(label, leaf);
      servers.push(server);
      ports[label] = await listen(server);
      route(name, ports[label]);
    }

    const { fakeUplink } = await import('@ai-ecoverse/slicc-kernel/testing');
    sealed = vault();
    jsh = await withJsh({ uplink: fakeUplink({ names, routes: { prefixes: [], exit: true }, peers, exit: 'tailscale' }), tlsEngine: true, sealed: sealed.hook });
    for (const name of ['pg', 'nodemailer']) {
      for (const [path, data] of devPackageTree(name)) await jsh.kernel.writeFile(`/os${path}`, data);
    }
    await jsh.kernel.writeFile('/os/ca.pem', ca.pem);
    // The kernel's bundled roots: the test CA alone.
    await jsh.kernel.writeFile('/node_modules/@ai-ecoverse/wasm-tls-engine/dist/roots.der', ca.der);
  });
  after(async () => {
    await jsh?.close();
    for (const s of servers) s.close?.();
  });

  /** Run `source` in jsh: argv is the ports (JSON), the placeholder, and where the packages are. */
  async function run(file, source) {
    await jsh.kernel.writeFile(`/os/${file}`, source);
    const r = await jsh.run(['node', file, JSON.stringify(ports), PLACEHOLDER, '/os/node_modules']);
    assert.equal(r.stdout.includes(SECRET), false, `the program saw the secret:\n${r.stdout}`);
    assert.equal(r.stderr.includes(SECRET), false, `the program saw the secret:\n${r.stderr}`);
    return r;
  }

  it('HTTP Authorization on a port that is not 443: the verified, bound server gets the secret; a reflecting endpoint gives the program none of it', { skip: skipFor('http1') }, async () => {
    got.length = 0;
    sealed.asked.clear();
    const r = await run(
      'http.js',
      `const https = require('https');
const fs = require('fs');
const [portsJson, placeholder] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const ca = fs.readFileSync('/os/ca.pem');
const agent = new https.Agent();
const get = (label, options) => new Promise((resolve) => {
  // No ca: the kernel's roots trust the server, as for a public one. An
  // agent of its own puts the request on jsh's TLS socket; without one (or a
  // ca, a certificate) it goes through fetch, whose transport substitutes.
  const req = https.request({ port: ports.api, agent, headers: { Authorization: 'Bearer ' + placeholder }, ...options }, (res) => {
    let b = '';
    res.on('data', (c) => (b += c));
    res.on('end', () => { console.log(label, res.statusCode, b); resolve(); });
  });
  req.on('error', (e) => { console.log(label, 'error', e.code); resolve(); });
  req.end(options.body);
});
(async () => {
  await get('bound', { host: 'api.test', path: '/' });
  await get('reflected', { host: 'api.test', path: '/echo' });
  await get('a body is no credential position', { host: 'api.test', path: '/', method: 'POST', body: 'token=' + placeholder });
})();
`
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^bound 200 ok$/m);
    assert.match(r.stdout, /^reflected 200 you sent /m);
    assert.deepEqual(gotFrom('api'), [`authorization Bearer ${SECRET}`, `authorization Bearer ${SECRET}`, `authorization Bearer ${SECRET}`, `body token=${PLACEHOLDER}`]);
    assert.deepEqual([...sealed.asked], ['api.test http1 header:authorization']);
  });

  it("HTTP Authorization where the kernel can't vouch for the bound host gets the placeholder: another host, a ca of the program's own, an untrusted chain, a wrong name, whatever the program accepts", { skip: skipFor('http1') }, async () => {
    got.length = 0;
    sealed.asked.clear();
    const r = await run(
      'http-unverified.js',
      `const https = require('https');
const fs = require('fs');
const [portsJson, placeholder] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const ca = fs.readFileSync('/os/ca.pem');
const agent = new https.Agent();
const get = (label, options) => new Promise((resolve) => {
  const req = https.request({ agent, headers: { Authorization: 'Bearer ' + placeholder }, path: '/', ...options }, (res) => {
    res.resume();
    res.on('end', () => { console.log(label, res.statusCode); resolve(); });
  });
  req.on('error', (e) => { console.log(label, 'error', e.code); resolve(); });
  req.end();
});
(async () => {
  await get('another verified host', { host: 'other-api.test', port: ports.otherApi });
  await get('a ca of its own, though the chain passes', { host: 'api.test', port: ports.api, ca, agent: false });
  await get('untrusted, rejectUnauthorized false', { host: 'untrusted.test', port: ports.untrusted, servername: 'api.test', rejectUnauthorized: false });
  await get('wrong name, rejectUnauthorized false', { host: 'mismatch.test', port: ports.mismatch, servername: 'api.test', rejectUnauthorized: false });
  await get('wrong name, a checkServerIdentity that takes it', { host: 'mismatch.test', port: ports.mismatch, servername: 'api.test', checkServerIdentity: () => undefined });
})();
`
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(sawSecret(), false, JSON.stringify(got));
    // Only a session the kernel verified asks the vault: the other host's.
    assert.deepEqual([...sealed.asked], ['other-api.test http1 header:authorization']);
    assert.deepEqual(
      got.map((g) => g.join(' ')),
      [
        `other-api authorization Bearer ${PLACEHOLDER}`,
        `api authorization Bearer ${PLACEHOLDER}`,
        `untrusted authorization Bearer ${PLACEHOLDER}`,
        `mismatch authorization Bearer ${PLACEHOLDER}`,
        `mismatch authorization Bearer ${PLACEHOLDER}`,
      ]
    );
  });

  it('SMTP AUTH PLAIN and LOGIN after STARTTLS and over SMTPS get the secret; AUTH before any upgrade gets the placeholder; a server quoting the password gives the program none of it', { skip: skipFor('smtp') }, async () => {
    got.length = 0;
    sealed.asked.clear();
    const r = await run(
      'smtp.js',
      `const [portsJson, placeholder, mods] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const fs = require('fs');
const nodemailer = require(mods + '/nodemailer');
const send = async (label, options) => {
  const t = nodemailer.createTransport({ name: 'client.test', ...options });
  try {
    await t.sendMail({ from: 'a@client.test', to: 'b@mail.test', subject: label, text: 'hi' });
    console.log(label, 'sent');
  } catch (e) {
    console.log(label, 'error', e.code, e.response);
  }
  t.close();
};
(async () => {
  const auth = (user = 'alice') => ({ user, pass: placeholder });
  await send('starttls PLAIN', { host: 'mail.test', port: ports.smtp, requireTLS: true, auth: auth(), authMethod: 'PLAIN' });
  await send('starttls LOGIN', { host: 'mail.test', port: ports.smtp, requireTLS: true, auth: auth(), authMethod: 'LOGIN' });
  await send('smtps PLAIN', { host: 'smtps.mail.test', port: ports.smtps, secure: true, tls: { servername: 'mail.test' }, auth: auth(), authMethod: 'PLAIN' });
  await send('plaintext PLAIN', { host: 'mail.test', port: ports.smtp, ignoreTLS: true, auth: auth(), authMethod: 'PLAIN' });
  await send('reflected', { host: 'mail.test', port: ports.smtp, requireTLS: true, auth: auth('reflect'), authMethod: 'PLAIN' });
})();
`
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^starttls PLAIN sent$/m);
    assert.match(r.stdout, /^reflected error EAUTH /m);
    assert.deepEqual(
      got.map((g) => g.join(' ')),
      [
        `smtp PLAIN secure ${SECRET}`,
        `smtp LOGIN secure ${SECRET}`,
        `smtps PLAIN secure ${SECRET}`,
        `smtp PLAIN plain ${PLACEHOLDER}`,
        `smtp PLAIN secure ${SECRET}`,
      ]
    );
    // SMTPS is verified against its servername, mail.test; the plaintext AUTH asks nothing.
    assert.deepEqual([...sealed.asked], ['mail.test smtp auth-plain', 'mail.test smtp auth-login']);
  });

  it("pg's cleartext password over sslmode=verify-full and require gets the secret where the kernel's roots trust the server; with a root of its own, without verification or without TLS it gets the placeholder; a server quoting it gives the program none of it", { skip: skipFor('pg') }, async () => {
    got.length = 0;
    sealed.asked.clear();
    const r = await run(
      'pg.js',
      `const [portsJson, placeholder, mods] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const { Client } = require(mods + '/pg');
const connect = async (label, user, host, port, query) => {
  const c = new Client({ connectionString: 'postgres://' + user + ':' + placeholder + '@' + host + ':' + port + '/db?' + query });
  c.on('error', () => {});
  try {
    await c.connect();
    console.log(label, 'connected');
    await c.end();
  } catch (e) {
    console.log(label, 'error', e.code, e.message);
  }
};
(async () => {
  await connect('verify-full', 'alice', 'db.test', ports.pg, 'sslmode=verify-full');
  await connect('require (libpq)', 'alice', 'db.test', ports.pg, 'sslmode=require&uselibpqcompat=true');
  await connect('verify-full, a root of its own', 'alice', 'db.test', ports.pg, 'sslmode=verify-full&sslrootcert=/os/ca.pem');
  await connect('require (libpq), untrusted', 'alice', 'untrusted-db.test', ports.pgUntrusted, 'sslmode=require&uselibpqcompat=true');
  await connect('disable', 'alice', 'db.test', ports.pg, 'sslmode=disable');
  await connect('reflected', 'reflect', 'db.test', ports.pg, 'sslmode=verify-full');
})();
`
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^verify-full connected$/m);
    assert.match(r.stdout, /^reflected error 28P01 password authentication failed: /m);
    assert.deepEqual(
      got.map((g) => g.join(' ')),
      [
        `pg password tls ${SECRET}`,
        `pg password tls ${SECRET}`,
        `pg password tls ${PLACEHOLDER}`,
        `pgUntrusted password tls ${PLACEHOLDER}`,
        `pg password plain ${PLACEHOLDER}`,
        `pg password tls ${SECRET}`,
      ]
    );
    assert.deepEqual([...sealed.asked], ['db.test pg password-cleartext']);
  });
});
