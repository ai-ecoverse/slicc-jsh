import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { createServer as createTcp, connect as tcp } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
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
// pg's cleartext PasswordMessage, pg's SCRAM-SHA-256 client-final), so a
// verified server that echoes its input can't hand the secret back.
//
// The test kernel's bundled roots are the test CA (the engine package's
// roots.der), so its servers verify as a public server would, and its uplink
// says which exit a connection leaves by (tailscale), which substitution
// needs.
//
// Each row is what a server receives and what the program sees. The program
// must never see the secret, whatever the server does with it.
//
// A vault-held trust anchor (slicc-kernel#1147, 1.136.0) verifies a session
// the bundled roots don't: a CA, the exact leaf, or an SPKI pin on the leaf
// or an issuer, which the vault answers for the bound host. A ca the program
// passes never does.
//
// Each protocol's rows run from the release that substitutes in it.
const SEALED = {
  http1: '1.127.0', // slicc-kernel#1130: an HTTP/1.1 request head's header, and the read scrub
  smtp: '1.129.0', // #1131: SMTP AUTH PLAIN and LOGIN's password, STARTTLS included
  pg: '1.131.0', // #1136: pg's cleartext PasswordMessage
  scram: '1.134.0', // #1138: pg's SCRAM-SHA-256, the proof recomputed from the secret
};
const skipFor = (protocol) =>
  !(SEALED[protocol] && kernelAtLeast(SEALED[protocol])) && `slicc-kernel#1090 doesn't substitute in ${protocol} yet`;
const skip = !kernelAtLeast('1.127.0') && 'slicc-kernel before 1.127.0 substitutes in no A2 session';
const skipAnchors = !kernelAtLeast('1.136.0') && 'slicc-kernel before 1.136.0 has no vault anchors (slicc-kernel#1147)';
// slicc-kernel#1224 (1.136.4): pg SCRAM channel binding in a sealed session.
// The kernel picks the gs2 header itself, tls-server-end-point where the
// bundled roots verified a server offering -PLUS, and an anchored session
// gets no binding. Its vault side, slicc-vault 1.15.1, isn't needed here:
// the vault is this file's own hook.
const skipBinding = !kernelAtLeast('1.136.4') && 'slicc-kernel before 1.136.4 has no sealed pg channel binding (slicc-kernel#1224)';
// slicc-kernel#1278 (1.137.0): a program's own SCRAM exchange in a session
// the kernel didn't verify passes through untouched, channel binding and all.
const skipOwnBinding = !kernelAtLeast('1.137.0') && "slicc-kernel before 1.137.0 rewrites the program's own channel binding (slicc-kernel#1278)";

// A placeholder as the vault makes them (fnox_proxy_<24 hex>).
const PLACEHOLDER = 'fnox_proxy_0123456789abcdef01234567';
const SECRET = 'jsh-1090-the-sealed-secret';
// A password of the program's own, not sealed: the SCRAM server's user `own`.
const OWN = 'jsh-1224-a-password-of-its-own';
// The host each protocol's secret is bound to, and the positions it may go to.
const BINDINGS = [
  { host: 'api.test', protocol: 'http1', positions: ['header:authorization'] },
  { host: 'mail.test', protocol: 'smtp', positions: ['auth-plain', 'auth-login'] },
  { host: 'db.test', protocol: 'pg', positions: ['password-cleartext', 'scram-sha-256'] },
];
const BOUND = { api: 'api.test', mail: 'mail.test', db: 'db.test' };

const sha256 = (b) => createHash('sha256').update(b).digest();
/** A vault anchor's name: sha256 of the anchor's whole DER, base64. */
const anchorOf = (der) => sha256(der).toString('base64');
/** An SPKI pin: sha256 of the certificate's SubjectPublicKeyInfo, base64. */
const pinOf = (der) => sha256(new X509Certificate(der).publicKey.export({ type: 'spki', format: 'der' })).toString('base64');
const hmac = (key, b) => createHmac('sha256', key).update(b).digest();
const xor = (a, b) => Buffer.from(a.map((v, i) => v ^ b[i]));
/** A SCRAM-SHA-256 verifier (RFC 5802 §3), as a server stores it. */
function scramVerifier(password, salt, iterations) {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return { storedKey: sha256(hmac(salted, 'Client Key')), serverKey: hmac(salted, 'Server Key') };
}
/** Whether `proof` is a client proof made from `verifier`'s password for `authMessage` (RFC 5802 §3). */
const proves = (verifier, authMessage, proof) =>
  proof.length === 32 && sha256(xor(proof, hmac(verifier.storedKey, authMessage))).equals(verifier.storedKey);
/** The salt and iteration count of a SCRAM server-first message. */
function saltOf(serverFirst) {
  const attrs = Object.fromEntries(serverFirst.split(',').map((a) => [a[0], a.slice(2)]));
  return [Buffer.from(attrs.s, 'base64'), Number(attrs.i)];
}

/**
 * The vault: PLACEHOLDER stands for SECRET, bound per BINDINGS. The kernel
 * asks it once per session it verified itself (slicc-kernel 1.126.0's
 * README): `{ v: 1, op: 'sessionMaterialize', caller, stamp, session, host,
 * port, protocol, position, verified, handshakeAt, exit, placeholders,
 * head? }`, answered `{ values }`. A placeholder that isn't answered goes out
 * as written. `asked` is what was asked, once per host, protocol and position.
 *
 * From slicc-kernel 1.136.0 it also asks `sessionAnchors { stamp, session,
 * host, port, protocol, exit }` at a session's first credential position,
 * answered with `anchors` (DER, base64) and SPKI `pins` (sha256, base64):
 * `anchor()` sets them, and a bound host gets them. A session one of them
 * verifies says `verifiedBy: 'anchored', anchor` in its sessionMaterialize.
 * `requests` is every request, in order.
 */
function vault() {
  const asked = new Set();
  const requests = [];
  let anchors = { anchors: [], pins: [] };
  const hook = async (req) => {
    if (req?.op === 'sessionAnchors') {
      requests.push(req);
      return BINDINGS.some((b) => b.host === req.host && b.protocol === req.protocol) ? anchors : { anchors: [], pins: [] };
    }
    if (req?.op !== 'sessionMaterialize') return { v: 1, error: { code: 'EINVAL' } };
    requests.push(req);
    assert.equal(req.verified, true, 'the kernel asks only for a session it verified');
    asked.add(`${req.host} ${req.protocol} ${req.position}`);
    const bound = BINDINGS.some((b) => b.host === req.host && b.protocol === req.protocol && b.positions.includes(req.position));
    if (req.position === 'scram-sha-256') {
      // pg SCRAM (slicc-kernel 1.134.0): no placeholders, but the three
      // messages and the program's proof; the vault names the bound placeholder
      // whose own proof matches it.
      const { clientFirstBare, serverFirst, clientFinalBare, proof } = req.scram;
      const authMessage = `${clientFirstBare},${serverFirst},${clientFinalBare.replace(/,p=[^,]*$/, '')}`;
      const ours = proves(scramVerifier(PLACEHOLDER, ...saltOf(serverFirst)), authMessage, Buffer.from(proof, typeof proof === 'string' ? 'base64' : undefined));
      return { values: bound && ours ? { [PLACEHOLDER]: SECRET } : {} };
    }
    return { values: bound && req.placeholders?.includes(PLACEHOLDER) ? { [PLACEHOLDER]: SECRET } : {} };
  };
  return {
    asked,
    requests,
    hook,
    /** What sessionAnchors answers for a bound host from now on, and a fresh record. */
    anchor({ anchors: a = [], pins = [] } = {}) {
      anchors = { anchors: a.map((der) => Buffer.from(der).toString('base64')), pins };
      asked.clear();
      requests.length = 0;
    },
  };
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

/**
 * A program that runs `steps` (JSON, argv[5]) in turn and prints `label:
 * result` for each: `{ label, http }` (an HTTPS request with Authorization
 * Bearer the placeholder, or `token`, on an agent of its own), `{ label, smtp }`
 * (nodemailer AUTH after STARTTLS) or `{ label, pg }` (a pg connection and a
 * query). `ca` names a PEM in /os. pg's `channelBinding: 'require'` refuses,
 * as libpq does, a server that offers no SCRAM-SHA-256-PLUS.
 */
const CLIENT = `const https = require('https');
const fs = require('fs');
const [, placeholder, mods, stepsJson] = process.argv.slice(2);
const nodemailer = require(mods + '/nodemailer');
const { Client } = require(mods + '/pg');
const sasl = require(mods + '/pg/lib/crypto/sasl');
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const pem = (name) => name && fs.readFileSync('/os/' + name + '.pem');
let requireBinding = false;
const startSession = sasl.startSession;
sasl.startSession = (mechanisms, ...rest) => {
  if (requireBinding && !mechanisms.includes('SCRAM-SHA-256-PLUS')) throw new Error('channel binding required, offered ' + mechanisms.join(' '));
  return startSession(mechanisms, ...rest);
};
const kinds = {
  http: (s) => new Promise((resolve) => {
    const options = clean({ host: s.host, port: s.port, path: s.path ?? '/', ca: pem(s.ca), rejectUnauthorized: s.rejectUnauthorized });
    const req = https.request({ ...options, agent: new https.Agent(), headers: { Authorization: 'Bearer ' + (s.token ?? placeholder) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(res.statusCode + ' ' + b));
    });
    req.on('error', (e) => resolve('error ' + e.code));
    req.end();
  }),
  smtp: async (s) => {
    const tls = clean({ ca: pem(s.ca), rejectUnauthorized: s.rejectUnauthorized });
    const t = nodemailer.createTransport({ name: 'client.test', host: s.host, port: s.port, requireTLS: true, tls, auth: { user: s.user ?? 'alice', pass: placeholder }, authMethod: s.method ?? 'PLAIN' });
    try {
      await t.sendMail({ from: 'a@client.test', to: 'b@mail.test', subject: 'hi', text: 'hi' });
      return 'sent';
    } catch (e) {
      return 'error ' + e.code + ' ' + e.response;
    } finally {
      t.close();
    }
  },
  pg: async (s) => {
    requireBinding = s.channelBinding === 'require';
    const c = new Client({ connectionString: 'postgres://' + (s.user ?? 'alice') + ':' + (s.password ?? placeholder) + '@' + s.host + ':' + s.port + '/db?' + s.query, enableChannelBinding: Boolean(s.channelBinding) });
    c.on('error', () => {});
    try {
      await c.connect();
      const q = await c.query('SELECT 1').then(() => 'queried', (e) => 'query error ' + e.code + ' ' + e.message);
      await c.end();
      return 'connected, ' + q;
    } catch (e) {
      // A client that refuses the server itself leaves the socket open.
      c.connection.stream.destroy();
      return 'error ' + e.code + ' ' + e.message;
    }
  },
};
(async () => {
  for (const step of JSON.parse(stepsJson)) {
    const kind = Object.keys(kinds).find((k) => step[k]);
    console.log(step.label + ': ' + (await kinds[kind](step[kind])));
  }
})();
`;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address ? server : server.server).address().port)));
}

describe('sealed values in the kernel\'s TLS sessions (slicc-kernel#1090)', { skip }, () => {
  let jsh;
  let sealed;
  const ca = makeCa();
  const other = makeCa('another CA');
  // A private CA the bundled roots lack, and an issuer that isn't a CA.
  const priv = makeCa('a private CA');
  const notCa = makeCa('not a CA', { notCa: true });
  // The leaves a test anchors or pins.
  const leaves = {};
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
    const smtpServer = (label, leaf, secure) => {
      const smtp = new SMTPServer({
        secure,
        key: leaf.key,
        cert: leaf.cert,
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
      return listen(smtp);
    };
    const mailLeaf = ca.server(BOUND.mail);
    for (const [label, secure] of [['smtp', false], ['smtps', true]]) ports[label] = await smtpServer(label, mailLeaf, secure);
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

    // pg with SCRAM-SHA-256 (RFC 5802, RFC 7677) as PostgreSQL does it: over
    // TLS it offers SCRAM-SHA-256-PLUS too, and refuses a client that says
    // `y` (it could bind but thinks the server can't) there, as a downgrade.
    // As auth-scram.c, it takes -PLUS only with `p=tls-server-end-point`, and
    // `p=` only with -PLUS, and checks the binding data itself: c= is the gs2
    // header and, for -PLUS, the hash of its own leaf (RFC 5929 §4.1, SHA-256
    // for the test CA's ECDSA-SHA256 signature).
    // It holds SECRET's verifier alone, checks the client's proof against it
    // and proves itself with its own signature (R 12) before R 0; a proof that
    // doesn't check gets 28P01. What it records is whose password the proof
    // was made from: SECRET's, PLACEHOLDER's (it tries that verifier too) or
    // neither. A user named `reflect` is refused in place of R 12 with the
    // client-final quoted; one named `echo` is let in, and refused its query
    // with the client-final quoted and the password it authenticated with.
    // One named `own` has OWN's verifier in place of SECRET's.
    const scramServer = (label, leaf) =>
      createTcp((sock) => {
        const int32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
        const cstr = (t) => Buffer.from(`${t}\0`);
        const msg = (type, body) => Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
        const refuse = (s, text) => s.end(msg('E', Buffer.concat([cstr('SFATAL'), cstr('C28P01'), cstr(`M${text}`), Buffer.from('\0')])));
        const speak = (s) => {
          const tls = Boolean(s.encrypted);
          const salt = randomBytes(16);
          const iterations = 4096;
          let verifier;
          let buf = Buffer.alloc(0);
          let user;
          let state = 'startup';
          let gs2;
          let binding;
          let clientFirstBare;
          let serverFirst;
          let nonce;
          let authenticated;
          let clientFinal;
          s.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            for (;;) {
              if (state === 'startup') {
                if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
                const len = buf.readInt32BE(0);
                const params = buf.subarray(8, len).toString().split('\0');
                buf = buf.subarray(len);
                user = params[params.indexOf('user') + 1];
                verifier = scramVerifier(user === 'own' ? OWN : SECRET, salt, iterations);
                const mechanisms = [...(tls ? ['SCRAM-SHA-256-PLUS'] : []), 'SCRAM-SHA-256'];
                s.write(msg('R', Buffer.concat([int32(10), ...mechanisms.map(cstr), Buffer.from('\0')])));
                state = 'initial';
                continue;
              }
              if (buf.length < 5 || buf.length < 1 + buf.readInt32BE(1)) return;
              const type = String.fromCharCode(buf[0]);
              const len = buf.readInt32BE(1);
              const body = buf.subarray(5, 1 + len);
              buf = buf.subarray(1 + len);
              if (state === 'initial' && type === 'p') {
                // SASLInitialResponse: the mechanism, then the client-first.
                const end = body.indexOf(0);
                const mechanism = body.subarray(0, end).toString();
                const clientFirst = body.subarray(end + 5).toString();
                gs2 = clientFirst.slice(0, clientFirst.indexOf(',', clientFirst.indexOf(',') + 1) + 1);
                clientFirstBare = clientFirst.slice(gs2.length);
                const plus = mechanism === 'SCRAM-SHA-256-PLUS' && tls && gs2 === 'p=tls-server-end-point,,';
                if (!plus && (mechanism !== 'SCRAM-SHA-256' || (gs2 === 'y,,' && tls) || !['n,,', 'y,,'].includes(gs2))) {
                  got.push([label, `scram ${gs2} ${tls ? 'tls' : 'plain'}`, `refused ${mechanism}`]);
                  return refuse(s, `SCRAM channel binding negotiation error for user "${user}"`);
                }
                binding = Buffer.concat([Buffer.from(gs2), plus ? sha256(leaf.der) : Buffer.alloc(0)]).toString('base64');
                nonce = `${/(?:^|,)r=([^,]*)/.exec(clientFirstBare)[1]}${randomBytes(18).toString('base64')}`;
                serverFirst = `r=${nonce},s=${salt.toString('base64')},i=${iterations}`;
                s.write(msg('R', Buffer.concat([int32(11), Buffer.from(serverFirst)])));
                state = 'final';
                continue;
              }
              if (state === 'final' && type === 'p') {
                clientFinal = body.toString();
                const withoutProof = clientFinal.replace(/,p=[^,]*$/, '');
                const proof = Buffer.from(/,p=([^,]*)$/.exec(clientFinal)?.[1] ?? '', 'base64');
                const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
                if (withoutProof !== `c=${binding},r=${nonce}`) {
                  got.push([label, `scram ${gs2} ${tls ? 'tls' : 'plain'}`, 'binding mismatch']);
                  return refuse(s, 'SCRAM channel binding check failed');
                }
                const ok = proves(verifier, authMessage, proof);
                const from = ok ? (user === 'own' ? OWN : SECRET) : proves(scramVerifier(PLACEHOLDER, salt, iterations), authMessage, proof) ? PLACEHOLDER : 'neither';
                got.push([label, `scram ${gs2} ${tls ? 'tls' : 'plain'}`, from]);
                if (!ok) return refuse(s, `password authentication failed for user "${user}"`);
                if (user === 'reflect') return refuse(s, `password authentication failed for user "${user}": you sent ${clientFinal}`);
                authenticated = from;
                const signature = hmac(verifier.serverKey, authMessage).toString('base64');
                s.write(Buffer.concat([msg('R', Buffer.concat([int32(12), Buffer.from(`v=${signature}`)])), msg('R', int32(0)), msg('K', Buffer.concat([int32(1), int32(2)])), msg('Z', Buffer.from('I'))]));
                state = 'ready';
                continue;
              }
              if (type === 'X') return s.end();
              if (state === 'ready' && type === 'Q') {
                if (user === 'echo') {
                  s.write(Buffer.concat([msg('E', Buffer.concat([cstr('SERROR'), cstr('C42501'), cstr(`Myou authenticated with ${authenticated}, sending ${clientFinal}`), Buffer.from('\0')])), msg('Z', Buffer.from('I'))]));
                } else {
                  s.write(Buffer.concat([msg('C', cstr('SELECT 0')), msg('Z', Buffer.from('I'))]));
                }
                continue;
              }
              return refuse(s, `unexpected ${type}`);
            }
          });
        };
        sock.once('data', (d) => {
          if (d.length !== 8 || d.readInt32BE(4) !== 80877103) {
            sock.unshift(d);
            return speak(sock);
          }
          sock.write('S');
          const secure = new TLSSocket(sock, { isServer: true, key: leaf.key, cert: leaf.cert });
          secure.on('error', () => {});
          speak(secure);
        });
      });
    // Each reached as db.test, the bound host, at its own port: a server the
    // kernel's roots trust, one another CA signed, one named something else.
    for (const [label, leaf] of [['scram', dbLeaf], ['scramUntrusted', other.server(BOUND.db)], ['scramMismatch', ca.server('other.test')]]) {
      const server = scramServer(label, leaf);
      servers.push(server);
      ports[label] = await listen(server);
      peers[`${names[BOUND.db][0]}:${ports[label]}`] = pipeTo(ports[label]);
    }

    // Under the private CA, or the issuer that isn't one, each reached as the
    // bound host at its own port: the servers a vault anchor is for. HTTP:
    // the bound leaf, another leaf for the same name, a leaf naming another
    // host, an expired leaf, and a leaf the non-CA issued.
    const alsoAt = (name, port) => (peers[`${names[name][0]}:${port}`] = pipeTo(port));
    const DAY = 86400_000;
    leaves.privApi = priv.server(BOUND.api);
    for (const [label, leaf] of [
      ['privApi', leaves.privApi],
      ['privApiOther', priv.server(BOUND.api)],
      ['privMismatch', priv.server('other.test')],
      ['privExpired', priv.server(BOUND.api, { notBefore: new Date(Date.now() - 10 * DAY), notAfter: new Date(Date.now() - DAY) })],
      ['notCaIssued', notCa.server(BOUND.api)],
    ]) {
      ports[label] = await httpsServer(label, leaf);
      alsoAt(BOUND.api, ports[label]);
    }
    ports.privSmtp = await smtpServer('privSmtp', priv.server(BOUND.mail), false);
    alsoAt(BOUND.mail, ports.privSmtp);
    const privDbLeaf = priv.server(BOUND.db);
    for (const [label, make] of [['privPg', pgServer], ['privScram', scramServer]]) {
      const server = make(label, privDbLeaf);
      servers.push(server);
      ports[label] = await listen(server);
      alsoAt(BOUND.db, ports[label]);
    }
    // The bound hosts' addresses, for a session to the IP literal.
    ports.apiAddress = names[BOUND.api][0];
    ports.dbAddress = names[BOUND.db][0];

    const { fakeUplink } = await import('@ai-ecoverse/slicc-kernel/testing');
    sealed = vault();
    jsh = await withJsh({ uplink: fakeUplink({ names, routes: { prefixes: [], exit: true }, peers, exit: 'tailscale' }), tlsEngine: true, sealed: sealed.hook });
    for (const name of ['pg', 'nodemailer']) {
      for (const [path, data] of devPackageTree(name)) await jsh.kernel.writeFile(`/os${path}`, data);
    }
    await jsh.kernel.writeFile('/os/ca.pem', ca.pem);
    await jsh.kernel.writeFile('/os/priv.pem', priv.pem);
    // The kernel's bundled roots: the test CA alone.
    await jsh.kernel.writeFile('/node_modules/@ai-ecoverse/wasm-tls-engine/dist/roots.der', ca.der);
  });
  after(async () => {
    await jsh?.close();
    for (const s of servers) s.close?.();
  });

  /** Run `source` in jsh: argv is the ports (JSON), the placeholder, where the packages are, and `args`. */
  async function run(file, source, ...args) {
    await jsh.kernel.writeFile(`/os/${file}`, source);
    const r = await jsh.run(['node', file, JSON.stringify(ports), PLACEHOLDER, '/os/node_modules', ...args]);
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

  it("pg's SCRAM-SHA-256 over sslmode=verify-full and require proves the secret where the kernel's roots trust the server, and the server's signature checks; with a root of its own, an untrusted chain, a wrong name or without TLS the proof is the placeholder's and authentication fails; a server quoting what it got gives the program none of it", { skip: skipFor('scram') }, async () => {
    got.length = 0;
    sealed.asked.clear();
    const r = await run(
      'pg-scram.js',
      `const [portsJson, placeholder, mods] = process.argv.slice(2);
const ports = JSON.parse(portsJson);
const { Client } = require(mods + '/pg');
const connect = async (label, user, port, query) => {
  const c = new Client({ connectionString: 'postgres://' + user + ':' + placeholder + '@db.test:' + port + '/db?' + query });
  c.on('error', () => {});
  try {
    // pg checks the server's signature (R 12) before it takes R 0.
    await c.connect();
    console.log(label, 'connected');
    await c.query('SELECT 1').then(() => console.log(label, 'queried'), (e) => console.log(label, 'query error', e.code, e.message));
    await c.end();
  } catch (e) {
    console.log(label, 'error', e.code, e.message);
  }
};
(async () => {
  await connect('verify-full', 'alice', ports.scram, 'sslmode=verify-full');
  await connect('require (libpq)', 'alice', ports.scram, 'sslmode=require&uselibpqcompat=true');
  await connect('verify-full, a root of its own', 'alice', ports.scram, 'sslmode=verify-full&sslrootcert=/os/ca.pem');
  await connect('require (libpq), untrusted', 'alice', ports.scramUntrusted, 'sslmode=require&uselibpqcompat=true');
  await connect('require (libpq), wrong name', 'alice', ports.scramMismatch, 'sslmode=require&uselibpqcompat=true');
  await connect('disable', 'alice', ports.scram, 'sslmode=disable');
  await connect('reflected', 'reflect', ports.scram, 'sslmode=verify-full');
  await connect('echoed', 'echo', ports.scram, 'sslmode=verify-full');
})();
`
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^verify-full queried$/m);
    assert.match(r.stdout, /^require \(libpq\) queried$/m);
    const lines = r.stdout.split('\n');
    for (const label of ['verify-full, a root of its own', 'require (libpq), untrusted', 'require (libpq), wrong name', 'disable']) {
      assert.ok(lines.includes(`${label} error 28P01 password authentication failed for user "alice"`), `${label}:\n${r.stdout}`);
    }
    // The server refusing the secret's proof ends the session: the kernel
    // never passes on what answers a client-final it recomputed but R 12.
    assert.match(r.stdout, /^reflected error ERR_SSL_PROTOCOL_ERROR /m);
    // The scrub hands back what the server quotes as the placeholder.
    assert.match(r.stdout, new RegExp(`^echoed query error 42501 you authenticated with ${PLACEHOLDER}, sending c=biws,`, 'm'));
    assert.deepEqual(
      got.map((g) => g.join(' ')),
      [
        `scram scram n,, tls ${SECRET}`,
        `scram scram n,, tls ${SECRET}`,
        `scram scram n,, tls ${PLACEHOLDER}`,
        `scramUntrusted scram n,, tls ${PLACEHOLDER}`,
        `scramMismatch scram n,, tls ${PLACEHOLDER}`,
        `scram scram n,, plain ${PLACEHOLDER}`,
        `scram scram n,, tls ${SECRET}`,
        `scram scram n,, tls ${SECRET}`,
      ]
    );
    assert.deepEqual([...sealed.asked], ['db.test pg scram-sha-256']);
  });

  /** Run CLIENT's `steps`: what the program printed for each, by label. */
  async function client(steps) {
    got.length = 0;
    const r = await run('client.js', CLIENT, JSON.stringify(steps));
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
  }
  const portName = (port) => Object.keys(ports).find((k) => ports[k] === port);
  /** The vault's requests in short: the server, the protocol or position, and how the session was trusted. */
  const trail = () =>
    sealed.requests.map((r) =>
      r.op === 'sessionAnchors' ? `anchors ${portName(r.port)} ${r.protocol}` : `materialize ${portName(r.port)} ${r.position} ${r.verifiedBy}${r.anchor ? ` ${r.anchor}` : ''}`
    );
  const api = (port, more) => ({ host: BOUND.api, port: ports[port], ...more });
  const smtp = (more) => ({ host: BOUND.mail, port: ports.privSmtp, ...more });
  const pg = (port, query, more) => ({ host: BOUND.db, port: ports[port], query, ...more });
  const VERIFY_PRIV = 'sslmode=verify-full&sslrootcert=/os/priv.pem';
  const REQUIRE = 'sslmode=require&uselibpqcompat=true';

  it('a private CA the vault anchors for the bound host verifies the session: HTTP Authorization, SMTP AUTH, and pg cleartext and SCRAM get the secret, whatever the program checks', { skip: skipAnchors }, async () => {
    sealed.anchor({ anchors: [priv.der] });
    const out = await client([
      { label: 'http, ca', http: api('privApi', { ca: 'priv' }) },
      { label: 'http, rejectUnauthorized false', http: api('privApi', { rejectUnauthorized: false }) },
      { label: 'smtp PLAIN', smtp: smtp({ ca: 'priv', method: 'PLAIN' }) },
      { label: 'smtp LOGIN', smtp: smtp({ ca: 'priv', method: 'LOGIN' }) },
      { label: 'pg cleartext', pg: pg('privPg', VERIFY_PRIV) },
      { label: 'pg scram, verify-full', pg: pg('privScram', VERIFY_PRIV) },
      { label: 'pg scram, require (libpq)', pg: pg('privScram', REQUIRE) },
    ]);
    assert.deepEqual(out, {
      'http, ca': '200 ok',
      'http, rejectUnauthorized false': '200 ok',
      'smtp PLAIN': 'sent',
      'smtp LOGIN': 'sent',
      'pg cleartext': 'connected, queried',
      'pg scram, verify-full': 'connected, queried',
      'pg scram, require (libpq)': 'connected, queried',
    });
    assert.deepEqual(
      got.map((g) => g.join(' ')),
      [
        `privApi authorization Bearer ${SECRET}`,
        `privApi authorization Bearer ${SECRET}`,
        `privSmtp PLAIN secure ${SECRET}`,
        `privSmtp LOGIN secure ${SECRET}`,
        `privPg password tls ${SECRET}`,
        `privScram scram n,, tls ${SECRET}`,
        `privScram scram n,, tls ${SECRET}`,
      ]
    );
    const ca = anchorOf(priv.der);
    assert.deepEqual(trail(), [
      'anchors privApi http1',
      `materialize privApi header:authorization anchored ${ca}`,
      'anchors privApi http1',
      `materialize privApi header:authorization anchored ${ca}`,
      'anchors privSmtp smtp',
      `materialize privSmtp auth-plain anchored ${ca}`,
      'anchors privSmtp smtp',
      `materialize privSmtp auth-login anchored ${ca}`,
      'anchors privPg pg',
      `materialize privPg password-cleartext anchored ${ca}`,
      'anchors privScram pg',
      `materialize privScram scram-sha-256 anchored ${ca}`,
      'anchors privScram pg',
      `materialize privScram scram-sha-256 anchored ${ca}`,
    ]);
  });

  it('the exact leaf as the anchor, or an SPKI pin on the leaf or on its issuer, gets the secret; another leaf for the same name gets the placeholder unless the issuer is pinned', { skip: skipAnchors }, async () => {
    const leaf = leaves.privApi.der;
    const steps = [
      { label: 'the leaf', http: api('privApi', { ca: 'priv' }) },
      { label: 'another leaf', http: api('privApiOther', { ca: 'priv' }) },
    ];
    for (const [answer, anchor, other] of [
      [{ anchors: [leaf] }, anchorOf(leaf), PLACEHOLDER],
      [{ pins: [pinOf(leaf)] }, pinOf(leaf), PLACEHOLDER],
      [{ pins: [pinOf(priv.der)] }, pinOf(priv.der), SECRET],
    ]) {
      sealed.anchor(answer);
      assert.deepEqual(await client(steps), { 'the leaf': '200 ok', 'another leaf': '200 ok' });
      assert.deepEqual(got.map((g) => g.join(' ')), [`privApi authorization Bearer ${SECRET}`, `privApiOther authorization Bearer ${other}`], anchor);
      assert.deepEqual(trail(), [
        'anchors privApi http1',
        `materialize privApi header:authorization anchored ${anchor}`,
        'anchors privApiOther http1',
        ...(other === SECRET ? [`materialize privApiOther header:authorization anchored ${anchor}`] : []),
      ]);
    }
  });

  it("the program's own ca is no anchor: the private CA as its ca or sslrootcert, with no vault anchor or another CA's, gets the placeholder", { skip: skipAnchors }, async () => {
    for (const answer of [{}, { anchors: [other.der], pins: [pinOf(other.der)] }]) {
      sealed.anchor(answer);
      const out = await client([
        { label: 'http', http: api('privApi', { ca: 'priv' }) },
        { label: 'smtp', smtp: smtp({ ca: 'priv' }) },
        { label: 'pg cleartext', pg: pg('privPg', VERIFY_PRIV) },
        { label: 'pg scram', pg: pg('privScram', VERIFY_PRIV) },
      ]);
      assert.deepEqual(out, {
        http: '200 ok',
        smtp: 'sent',
        'pg cleartext': 'connected, queried',
        'pg scram': 'error 28P01 password authentication failed for user "alice"',
      });
      assert.deepEqual(
        got.map((g) => g.join(' ')),
        [`privApi authorization Bearer ${PLACEHOLDER}`, `privSmtp PLAIN secure ${PLACEHOLDER}`, `privPg password tls ${PLACEHOLDER}`, `privScram scram n,, tls ${PLACEHOLDER}`]
      );
      // The vault is asked for anchors, and never for a value.
      assert.deepEqual(trail(), ['anchors privApi http1', 'anchors privSmtp smtp', 'anchors privPg pg', 'anchors privScram pg']);
    }
  });

  it('an anchor still checks name, validity and usage: an anchored CA with a leaf naming another host or an expired leaf, and an anchor or pin that is no CA issuing, get the placeholder', { skip: skipAnchors }, async () => {
    sealed.anchor({ anchors: [priv.der, notCa.der], pins: [pinOf(notCa.der)] });
    const unchecked = { rejectUnauthorized: false };
    const out = await client([
      { label: 'anchored', http: api('privApi', unchecked) },
      { label: 'wrong name', http: api('privMismatch', unchecked) },
      { label: 'expired', http: api('privExpired', unchecked) },
      { label: 'issued by no CA', http: api('notCaIssued', unchecked) },
    ]);
    assert.deepEqual(out, { anchored: '200 ok', 'wrong name': '200 ok', expired: '200 ok', 'issued by no CA': '200 ok' });
    assert.deepEqual(
      got.map((g) => g.join(' ')),
      [
        `privApi authorization Bearer ${SECRET}`,
        `privMismatch authorization Bearer ${PLACEHOLDER}`,
        `privExpired authorization Bearer ${PLACEHOLDER}`,
        `notCaIssued authorization Bearer ${PLACEHOLDER}`,
      ]
    );
    assert.deepEqual(trail(), [
      'anchors privApi http1',
      `materialize privApi header:authorization anchored ${anchorOf(priv.der)}`,
      'anchors privMismatch http1',
      'anchors privExpired http1',
      'anchors notCaIssued http1',
    ]);
  });

  it('an anchored server reflecting the secret gives the program none of it: an HTTP echo, an SMTP refusal and pg refusals quoting it', { skip: skipAnchors }, async () => {
    sealed.anchor({ anchors: [priv.der] });
    // run() fails on the secret in the program's output.
    const out = await client([
      { label: 'http echo', http: api('privApi', { ca: 'priv', path: '/echo' }) },
      { label: 'smtp', smtp: smtp({ ca: 'priv', user: 'reflect' }) },
      { label: 'pg cleartext', pg: pg('privPg', VERIFY_PRIV, { user: 'reflect' }) },
      { label: 'pg scram, reflected', pg: pg('privScram', VERIFY_PRIV, { user: 'reflect' }) },
      { label: 'pg scram, echoed', pg: pg('privScram', VERIFY_PRIV, { user: 'echo' }) },
    ]);
    // The scrub hands back the placeholder, cut to the secret's length.
    assert.match(out['http echo'], /^200 you sent Bearer fnox_proxy_/);
    assert.match(out.smtp, /^error EAUTH /);
    assert.equal(out['pg cleartext'], `error 28P01 password authentication failed: ${PLACEHOLDER}`);
    assert.match(out['pg scram, reflected'], /^error ERR_SSL_PROTOCOL_ERROR /);
    assert.match(out['pg scram, echoed'], new RegExp(`^connected, query error 42501 you authenticated with ${PLACEHOLDER}, sending c=biws,`));
    assert.deepEqual(
      got.map((g) => g.join(' ')),
      [
        `privApi authorization Bearer ${SECRET}`,
        `privSmtp PLAIN secure ${SECRET}`,
        `privPg password tls ${SECRET}`,
        `privScram scram n,, tls ${SECRET}`,
        `privScram scram n,, tls ${SECRET}`,
      ]
    );
  });

  it('the vault is asked sessionAnchors once per session, at its credential position, with the session and its exit, and nothing for an IP literal', { skip: skipAnchors }, async () => {
    sealed.anchor({ anchors: [priv.der] });
    const address = { host: ports.apiAddress, port: ports.privApi, rejectUnauthorized: false };
    const out = await client([
      { label: 'first', http: api('privApi', { ca: 'priv' }) },
      { label: 'no placeholder', http: api('privApi', { ca: 'priv', token: 'not-sealed' }) },
      { label: 'second', http: api('privApi', { ca: 'priv' }) },
      { label: 'http to the address', http: address },
      { label: 'pg to the address', pg: { host: ports.dbAddress, port: ports.privPg, query: REQUIRE } },
    ]);
    assert.deepEqual(out, { first: '200 ok', 'no placeholder': '200 ok', second: '200 ok', 'http to the address': '200 ok', 'pg to the address': 'connected, queried' });
    assert.deepEqual(
      got.map((g) => g.join(' ')),
      [
        `privApi authorization Bearer ${SECRET}`,
        'privApi authorization Bearer not-sealed',
        `privApi authorization Bearer ${SECRET}`,
        `privApi authorization Bearer ${PLACEHOLDER}`,
        `privPg password tls ${PLACEHOLDER}`,
      ]
    );
    const [a1, m1, a2, m2, ...rest] = sealed.requests;
    assert.deepEqual(rest, [], 'the IP literal and the request without a placeholder ask nothing');
    for (const [a, m] of [[a1, m1], [a2, m2]]) {
      // The broker adds the caller, as to every request; no value, no verdict.
      const { caller, stamp, session, ...fields } = a;
      assert.deepEqual(fields, { v: 1, op: 'sessionAnchors', host: BOUND.api, port: ports.privApi, protocol: 'http1', exit: 'tailscale' });
      assert.equal(typeof caller.pid, 'number');
      assert.ok(stamp, 'a stamp');
      assert.equal(typeof session, 'string');
      assert.deepEqual([m.op, m.session, m.verifiedBy, m.anchor, m.exit], ['sessionMaterialize', session, 'anchored', anchorOf(priv.der), 'tailscale']);
    }
    assert.notEqual(a1.session, a2.session);
  });

  it('the SCRAM server checks channel binding itself: pg on the host binds to its leaf (tls-server-end-point, RFC 5929) and authenticates; binding data for another leaf is refused', async () => {
    // pg outside jsh, to the fixture directly: what a client's own binding
    // proves to it, with no kernel in between.
    const { Client } = createRequire(import.meta.url)('pg');
    const sasl = createRequire(import.meta.url)('pg/lib/crypto/sasl');
    const connect = async (stream) => {
      got.length = 0;
      const c = new Client({ host: '127.0.0.1', port: ports.scram, user: 'alice', password: SECRET, database: 'db', ssl: { ca: ca.pem, servername: BOUND.db }, enableChannelBinding: true });
      c.on('error', () => {});
      const continueSession = sasl.continueSession;
      if (stream) sasl.continueSession = (session, password, data) => continueSession(session, password, data, stream);
      try {
        await c.connect();
        await c.end();
        return 'connected';
      } catch (e) {
        c.connection.stream.destroy();
        return `error ${e.code} ${e.message}`;
      } finally {
        sasl.continueSession = continueSession;
      }
    };
    assert.equal(await connect(), 'connected');
    assert.deepEqual(got.map((g) => g.join(' ')), [`scram scram p=tls-server-end-point,, tls ${SECRET}`]);
    const otherLeaf = ca.server(BOUND.db).der;
    assert.equal(await connect({ getPeerCertificate: () => ({ raw: otherLeaf }) }), 'error 28P01 SCRAM channel binding check failed');
    assert.deepEqual(got.map((g) => g.join(' ')), ['scram scram p=tls-server-end-point,, tls binding mismatch']);
  });

  // slicc-kernel#1224: in a session the bundled roots verified, the kernel
  // offers SCRAM-SHA-256-PLUS and binds to the leaf it verified. Where it
  // didn't verify the server it drops -PLUS and sends n,, for a y,, (pg
  // refuses y,, after offering -PLUS), so the program's own proof, from the
  // placeholder over y,,, proves nothing; require fails closed in the program.
  // From slicc-kernel#1278 (1.137.0) it leaves those sessions alone, -PLUS and
  // all: the program binds with the placeholder's proof, which still fails.
  it("pg channel binding where the bundled roots verify the server: enableChannelBinding (libpq's channel_binding=prefer) and require bind to the server's leaf and authenticate with the secret; with a root of its own, an untrusted chain, a wrong name or without TLS, the placeholder's proof fails, and require fails closed or, from 1.137.0, binds and fails", { skip: skipBinding }, async () => {
    sealed.anchor({});
    const verified = [['verify-full', 'scram', 'sslmode=verify-full'], ['require (libpq)', 'scram', REQUIRE]];
    const unverified = [
      ['verify-full, a root of its own', 'scram', 'sslmode=verify-full&sslrootcert=/os/ca.pem'],
      ['require (libpq), untrusted', 'scramUntrusted', REQUIRE],
      ['require (libpq), wrong name', 'scramMismatch', REQUIRE],
      ['disable', 'scram', 'sslmode=disable'],
    ];
    const steps = ['prefer', 'require'].flatMap((cb) => [...verified, ...unverified].map(([label, port, query]) => ({ label: `${cb}, ${label}`, pg: pg(port, query, { channelBinding: cb }) })));
    const out = await client(steps);
    const failed = 'error 28P01 password authentication failed for user "alice"';
    const closed = 'error undefined channel binding required, offered SCRAM-SHA-256';
    const passed = kernelAtLeast('1.137.0');
    assert.deepEqual(out, {
      'prefer, verify-full': 'connected, queried',
      'prefer, require (libpq)': 'connected, queried',
      'prefer, verify-full, a root of its own': failed,
      'prefer, require (libpq), untrusted': failed,
      'prefer, require (libpq), wrong name': failed,
      'prefer, disable': failed,
      'require, verify-full': 'connected, queried',
      'require, require (libpq)': 'connected, queried',
      'require, verify-full, a root of its own': passed ? failed : closed,
      'require, require (libpq), untrusted': passed ? failed : closed,
      'require, require (libpq), wrong name': passed ? failed : closed,
      'require, disable': closed,
    });
    // The server checked c= against its own leaf for each -PLUS.
    const bound = `scram scram p=tls-server-end-point,, tls ${SECRET}`;
    const untouched = ['scram', 'scramUntrusted', 'scramMismatch'].map((server) =>
      passed ? `${server} scram p=tls-server-end-point,, tls ${PLACEHOLDER}` : `${server} scram n,, tls neither`
    );
    assert.deepEqual(got.map((g) => g.join(' ')), [bound, bound, ...untouched, `scram scram y,, plain ${PLACEHOLDER}`, bound, bound, ...(passed ? untouched : [])]);
    const asked = ['anchors scram pg', 'anchors scramUntrusted pg', 'anchors scramMismatch pg'];
    const roots = ['anchors scram pg', 'materialize scram scram-sha-256 roots'];
    assert.deepEqual(trail(), [...roots, ...roots, ...asked, ...roots, ...roots, ...(passed ? asked : [])]);
  });

  it("pg channel binding with a password of the program's own, where nothing has to change: bound to a server the bundled roots verify, and unbound without TLS, it authenticates", { skip: skipBinding }, async () => {
    sealed.anchor({});
    const own = (query, channelBinding) => pg('scram', query, { user: 'own', password: OWN, channelBinding });
    const out = await client([
      { label: 'prefer, verify-full', pg: own('sslmode=verify-full', 'prefer') },
      { label: 'require, require (libpq)', pg: own(REQUIRE, 'require') },
      { label: 'prefer, disable', pg: own('sslmode=disable', 'prefer') },
    ]);
    assert.deepEqual(out, { 'prefer, verify-full': 'connected, queried', 'require, require (libpq)': 'connected, queried', 'prefer, disable': 'connected, queried' });
    assert.deepEqual(got.map((g) => g.join(' ')), [`scram scram p=tls-server-end-point,, tls ${OWN}`, `scram scram p=tls-server-end-point,, tls ${OWN}`, `scram scram y,, plain ${OWN}`]);
  });

  // On 1.136.4 the kernel dropped -PLUS and rewrote the program's y,, to n,,
  // in a session it didn't verify but a vault anchor still could (a root of
  // the program's own, an untrusted chain), so a program authenticating with
  // its own password and libpq's default channel_binding=prefer failed there.
  // slicc-kernel#1278 (1.137.0) touches SCRAM only where a sealed value could
  // be substituted, and passes the program's own exchange through untouched:
  // it binds where the server offers -PLUS, as it would without the kernel.
  it("pg channel binding with a password of the program's own in a session the kernel didn't verify: a root of its own, a private CA through sslrootcert and an untrusted chain, prefer and require bind and authenticate", { skip: skipOwnBinding }, async () => {
    sealed.anchor({});
    const own = (port, query, channelBinding) => pg(port, query, { user: 'own', password: OWN, channelBinding });
    const steps = ['prefer', 'require'].flatMap((cb) => [
      { label: `${cb}, a root of its own`, pg: own('scram', 'sslmode=verify-full&sslrootcert=/os/ca.pem', cb) },
      { label: `${cb}, a private CA`, pg: own('privScram', VERIFY_PRIV, cb) },
      { label: `${cb}, untrusted`, pg: own('scramUntrusted', REQUIRE, cb) },
    ]);
    const out = await client(steps);
    assert.deepEqual(out, Object.fromEntries(steps.map((s) => [s.label, 'connected, queried'])));
    const bound = ['scram', 'privScram', 'scramUntrusted'].map((server) => `${server} scram p=tls-server-end-point,, tls ${OWN}`);
    assert.deepEqual(got.map((g) => g.join(' ')), [...bound, ...bound]);
  });

  // slicc-kernel#1224 binds SCRAM-SHA-256-PLUS only in a session the bundled
  // roots verified: an anchored one gets no -PLUS (slicc-kernel#1259).
  it("pg channel binding in an anchored session: pg's enableChannelBinding (libpq's prefer) authenticates unbound with the secret", { skip: skipAnchors || skipBinding }, async () => {
    sealed.anchor({ anchors: [priv.der] });
    const out = await client([{ label: 'prefer', pg: pg('privScram', VERIFY_PRIV, { channelBinding: 'prefer' }) }]);
    assert.deepEqual(out, { prefer: 'connected, queried' });
    assert.deepEqual(got.map((g) => g.join(' ')), [`privScram scram n,, tls ${SECRET}`]);
  });

  it("pg channel binding in an anchored session: libpq's channel_binding=require fails closed, offered no -PLUS, and nothing is sent", { skip: skipAnchors || skipBinding }, async () => {
    sealed.anchor({ anchors: [priv.der] });
    const out = await client([{ label: 'require', pg: pg('privScram', VERIFY_PRIV, { channelBinding: 'require' }) }]);
    assert.deepEqual(out, { require: 'error undefined channel binding required, offered SCRAM-SHA-256' });
    assert.deepEqual(got, []);
    assert.equal(sealed.requests.some((r) => r.op === 'sessionMaterialize'), false);
  });
});
