import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createTcp, connect as tcp } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { devPackageTree, withJsh } from './helpers.mjs';
import { makeCa } from './tls-certs.mjs';

// Sealed values against a real PostgreSQL over TLS (the kernel net lane's
// ask): pg's SCRAM-SHA-256 with channel binding, as slicc-kernel#1224
// (1.136.4) does it in a session its bundled roots verified, checked by
// PostgreSQL's own auth-scram.c rather than a fixture of ours. The server is
// npm's embedded-postgres (PostgreSQL's binaries, run as this user: the CI
// pool has no root, and PostgreSQL refuses to run as root anyway). Its leaf
// is the test CA's, and the kernel's bundled roots are the test CA alone, as
// in tls-sealed.test.mjs, whose in-file vault this one follows.
//
// PostgreSQL holds SECRET's verifier (the bootstrap user alice) and OWN's
// (own), so connecting is authenticating with that password: alice with
// the placeholder gets in only if the kernel put the secret in its place.
const require = createRequire(import.meta.url);
const PLACEHOLDER = 'fnox_proxy_0123456789abcdef01234567';
const SECRET = 'jsh-1224-the-sealed-secret';
const OWN = 'jsh-1224-a-password-of-its-own';
const DB = 'db.test';

const skip = process.getuid?.() === 0 && 'PostgreSQL refuses to run as root';

// slicc-kernel#1278: a program's own SCRAM exchange in a session the kernel
// didn't verify passes through untouched, channel binding and all.

const sha256 = (b) => createHash('sha256').update(b).digest();
const hmac = (key, b) => createHmac('sha256', key).update(b).digest();
const xor = (a, b) => Buffer.from(a.map((v, i) => v ^ b[i]));

/**
 * The vault, as in tls-sealed.test.mjs: PLACEHOLDER stands for SECRET, bound
 * to db.test's pg scram-sha-256 position. It names the placeholder when the
 * program's proof is the placeholder's (RFC 5802 §3). No anchors.
 */
function vault() {
  const requests = [];
  const hook = async (req) => {
    if (req?.op === 'sessionAnchors') return { anchors: [], pins: [] };
    if (req?.op !== 'sessionMaterialize') return { v: 1, error: { code: 'EINVAL' } };
    requests.push(`${req.host} ${req.position} ${req.verifiedBy}`);
    if (req.host !== DB || req.protocol !== 'pg' || req.position !== 'scram-sha-256') return { values: {} };
    const { clientFirstBare, serverFirst, clientFinalBare, proof } = req.scram;
    const attrs = Object.fromEntries(serverFirst.split(',').map((a) => [a[0], a.slice(2)]));
    const salted = pbkdf2Sync(PLACEHOLDER, Buffer.from(attrs.s, 'base64'), Number(attrs.i), 32, 'sha256');
    const storedKey = sha256(hmac(salted, 'Client Key'));
    const authMessage = `${clientFirstBare},${serverFirst},${clientFinalBare.replace(/,p=[^,]*$/, '')}`;
    const p = Buffer.from(proof, typeof proof === 'string' ? 'base64' : undefined);
    const ours = p.length === 32 && sha256(xor(p, hmac(storedKey, authMessage))).equals(storedKey);
    return { values: ours ? { [PLACEHOLDER]: SECRET } : {} };
  };
  return { hook, requests };
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
 * The platform package's library symlinks (native/pg-symlinks.json), which
 * its postinstall makes and npm, holding install scripts back, may not have
 * run: PostgreSQL's binaries link the sonames.
 */
function hydrate() {
  const pkg = join(dirname(require.resolve(`@embedded-postgres/${process.platform}-${process.arch}`)), '..');
  const list = join(pkg, 'native', 'pg-symlinks.json');
  if (!existsSync(list)) return;
  for (const { source, target } of JSON.parse(readFileSync(list, 'utf8'))) {
    const to = join(pkg, target);
    if (!existsSync(to)) symlinkSync(relative(dirname(to), join(pkg, source)), to);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = createTcp().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * A program that runs `steps` (JSON, argv[4]) in turn and prints `label:
 * result`: a pg connection, `SELECT ssl FROM pg_stat_ssl` for its own
 * backend, and the SASL mechanism it chose. `channelBinding` sets pg's
 * enableChannelBinding (libpq's channel_binding=prefer); `require` also
 * refuses, as libpq does, a server that offers no SCRAM-SHA-256-PLUS.
 */
const CLIENT = `const [placeholder, mods, stepsJson] = process.argv.slice(2);
const { Client } = require(mods + '/pg');
const sasl = require(mods + '/pg/lib/crypto/sasl');
let requireBinding = false;
let mechanism;
const startSession = sasl.startSession;
sasl.startSession = (mechanisms, ...rest) => {
  if (requireBinding && !mechanisms.includes('SCRAM-SHA-256-PLUS')) throw new Error('channel binding required, offered ' + mechanisms.join(' '));
  const session = startSession(mechanisms, ...rest);
  mechanism = session.mechanism;
  return session;
};
(async () => {
  for (const s of JSON.parse(stepsJson)) {
    requireBinding = s.channelBinding === 'require';
    mechanism = undefined;
    const user = s.user ?? 'alice';
    const c = new Client({ connectionString: 'postgres://' + user + ':' + (s.password ?? placeholder) + '@' + (s.host ?? 'db.test') + ':' + s.port + '/postgres?' + s.query, enableChannelBinding: Boolean(s.channelBinding) });
    c.on('error', () => {});
    let out;
    try {
      await c.connect();
      const r = await c.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
      out = 'connected, ssl ' + r.rows[0].ssl + ', ' + mechanism;
      await c.end();
    } catch (e) {
      c.connection.stream.destroy();
      out = 'error ' + e.code + ' ' + e.message;
    }
    console.log(s.label + ': ' + out);
  }
})();
`;

describe('sealed pg SCRAM channel binding against a real PostgreSQL over TLS (slicc-kernel#1224)', { skip }, () => {
  let jsh;
  let sealed;
  const postgres = [];
  let port;
  let privPort;
  const scratch = mkdtempSync(join(tmpdir(), 'jsh-postgres-'));
  const ca = makeCa();
  // A private CA the bundled roots lack, which the program passes as its
  // sslrootcert.
  const priv = makeCa('a private CA');

  /** A PostgreSQL in scratch/`name` with `leaf`, holding alice's and own's verifiers. */
  async function startPostgres(EmbeddedPostgres, name, leaf) {
    const dir = join(scratch, name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'server.crt'), leaf.cert);
    writeFileSync(join(dir, 'server.key'), leaf.key);
    chmodSync(join(dir, 'server.key'), 0o600);
    const at = await freePort();
    const log = [];
    const pg = new EmbeddedPostgres({
      databaseDir: join(dir, 'data'),
      user: 'alice',
      password: SECRET,
      port: at,
      persistent: false,
      authMethod: 'scram-sha-256',
      onLog: (m) => log.push(String(m)),
      onError: (m) => log.push(String(m)),
      postgresFlags: ['-c', 'ssl=on', '-c', `ssl_cert_file=${dir}/server.crt`, '-c', `ssl_key_file=${dir}/server.key`, '-c', 'listen_addresses=127.0.0.1', '-c', `unix_socket_directories=${dir}`],
    });
    postgres.push(pg);
    try {
      await pg.initialise();
      await pg.start();
    } catch (e) {
      throw new Error(`PostgreSQL didn't start: ${e?.message ?? e}\n${log.join('')}`);
    }
    const admin = pg.getPgClient();
    await admin.connect();
    await admin.query(`CREATE ROLE own LOGIN PASSWORD '${OWN}'`);
    await admin.end();
    return at;
  }

  before(async () => {
    hydrate();
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    // A leaf for both names, so a session to either verifies.
    port = await startPostgres(EmbeddedPostgres, 'public', ca.server(DB, { san: [`DNS:${DB}`, 'DNS:other-db.test'] }));
    // db.test's leaf from the private CA, at a port of its own.
    privPort = await startPostgres(EmbeddedPostgres, 'private', priv.server(DB));

    // db.test, the bound host, and other-db.test, a name the secret isn't
    // bound to, both at PostgreSQL, whose leaf names both. The private
    // PostgreSQL is db.test too, at its own port.
    const names = { [DB]: ['203.0.113.70'], 'other-db.test': ['203.0.113.71'] };
    const peers = { [`203.0.113.70:${port}`]: pipeTo(port), [`203.0.113.71:${port}`]: pipeTo(port), [`203.0.113.70:${privPort}`]: pipeTo(privPort) };
    const { fakeUplink } = await import('@ai-ecoverse/slicc-kernel/testing');
    sealed = vault();
    jsh = await withJsh({ uplink: fakeUplink({ names, routes: { prefixes: [], exit: true }, peers, exit: 'tailscale' }), tlsEngine: true, sealed: sealed.hook });
    for (const [path, data] of devPackageTree('pg')) await jsh.kernel.writeFile(`/os${path}`, data);
    await jsh.kernel.writeFile('/os/ca.pem', ca.pem);
    await jsh.kernel.writeFile('/os/priv.pem', priv.pem);
    // The kernel's bundled roots: the test CA alone.
    await jsh.kernel.writeFile('/node_modules/@ai-ecoverse/wasm-tls-engine/dist/roots.der', ca.der);
  });
  after(async () => {
    await jsh?.close();
    for (const pg of postgres) await pg.stop().catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  });

  /** Run CLIENT's steps: what the program printed for each, by label. */
  async function client(steps) {
    sealed.requests.length = 0;
    await jsh.kernel.writeFile('/os/client.js', CLIENT);
    const r = await jsh.run(['node', 'client.js', PLACEHOLDER, '/os/node_modules', JSON.stringify(steps.map((s) => ({ port, ...s })))]);
    assert.equal(r.stdout.includes(SECRET), false, `the program saw the secret:\n${r.stdout}`);
    assert.equal(r.stderr.includes(SECRET), false, `the program saw the secret:\n${r.stderr}`);
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
  }
  const VERIFY = 'sslmode=verify-full';
  const REQUIRE = 'sslmode=require&uselibpqcompat=true';
  const OWN_ROOT = 'sslmode=verify-full&sslrootcert=/os/ca.pem';
  const PRIV_ROOT = 'sslmode=verify-full&sslrootcert=/os/priv.pem';
  const plus = 'connected, ssl true, SCRAM-SHA-256-PLUS';
  const failed = 'error 28P01 password authentication failed for user "alice"';

  it("scram-sha-256 where the bundled roots verify PostgreSQL: pg's enableChannelBinding (libpq's channel_binding=prefer) and require bind with SCRAM-SHA-256-PLUS and authenticate with the secret; unbound, it does too", async () => {
    const out = await client([
      { label: 'prefer, verify-full', query: VERIFY, channelBinding: 'prefer' },
      { label: 'prefer, require (libpq)', query: REQUIRE, channelBinding: 'prefer' },
      { label: 'require, verify-full', query: VERIFY, channelBinding: 'require' },
      { label: 'require, require (libpq)', query: REQUIRE, channelBinding: 'require' },
      { label: 'no binding, verify-full', query: VERIFY },
    ]);
    assert.deepEqual(out, {
      'prefer, verify-full': plus,
      'prefer, require (libpq)': plus,
      'require, verify-full': plus,
      'require, require (libpq)': plus,
      'no binding, verify-full': 'connected, ssl true, SCRAM-SHA-256',
    });
    assert.deepEqual(sealed.requests, Array(5).fill(`${DB} scram-sha-256 roots`));
  });

  it("the placeholder where the kernel can't vouch for PostgreSQL or the secret isn't bound: verify-full with the program's own sslrootcert, a host the secret isn't bound to, and no TLS fail authentication; require fails closed or, from 1.137.0, binds and fails", async () => {
    const out = await client([
      { label: 'a private CA, prefer', port: privPort, query: PRIV_ROOT, channelBinding: 'prefer' },
      { label: 'a private CA, require', port: privPort, query: PRIV_ROOT, channelBinding: 'require' },
      { label: 'own sslrootcert, prefer', query: OWN_ROOT, channelBinding: 'prefer' },
      { label: 'own sslrootcert, no binding', query: OWN_ROOT },
      { label: 'own sslrootcert, require', query: OWN_ROOT, channelBinding: 'require' },
      { label: 'another host, prefer', host: 'other-db.test', query: REQUIRE, channelBinding: 'prefer' },
      { label: 'another host, require', host: 'other-db.test', query: REQUIRE, channelBinding: 'require' },
      { label: 'disable, prefer', query: 'sslmode=disable', channelBinding: 'prefer' },
    ]);
    assert.deepEqual(out, {
      'a private CA, prefer': failed,
      'a private CA, require': failed,
      'own sslrootcert, prefer': failed,
      'own sslrootcert, no binding': failed,
      // slicc-kernel#1278 (1.137.0) leaves the session alone, -PLUS and all.
      'own sslrootcert, require': failed,
      // Verified, so bound, but the vault has nothing for this host.
      'another host, prefer': failed,
      'another host, require': failed,
      'disable, prefer': failed,
    });
    // Only the sessions the bundled roots verified ask for a value.
    assert.deepEqual(sealed.requests, ['other-db.test scram-sha-256 roots', 'other-db.test scram-sha-256 roots']);
  });

  it("a password of the program's own, where nothing has to change: bound to a PostgreSQL the bundled roots verify, and unbound without TLS, it authenticates", async () => {
    const own = { user: 'own', password: OWN };
    const out = await client([
      { label: 'prefer, verify-full', query: VERIFY, channelBinding: 'prefer', ...own },
      { label: 'require, require (libpq)', query: REQUIRE, channelBinding: 'require', ...own },
      { label: 'prefer, disable', query: 'sslmode=disable', channelBinding: 'prefer', ...own },
    ]);
    assert.deepEqual(out, {
      'prefer, verify-full': plus,
      'require, require (libpq)': plus,
      'prefer, disable': 'connected, ssl false, SCRAM-SHA-256',
    });
  });

  // On 1.136.4 the kernel dropped -PLUS and rewrote the program's y,, to n,,
  // in a session it didn't verify, so libpq's default channel_binding=prefer
  // failed there with a password of the program's own. slicc-kernel#1278
  // (1.137.0) passes that exchange through: PostgreSQL checks the binding.
  it("a password of the program's own in a session the kernel didn't verify: a root of its own and a private CA through sslrootcert, prefer and require bind with SCRAM-SHA-256-PLUS and authenticate", async () => {
    const own = { user: 'own', password: OWN };
    const steps = ['prefer', 'require'].flatMap((channelBinding) => [
      { label: `${channelBinding}, a root of its own`, query: OWN_ROOT, channelBinding, ...own },
      { label: `${channelBinding}, a private CA`, port: privPort, query: PRIV_ROOT, channelBinding, ...own },
    ]);
    const out = await client(steps);
    assert.deepEqual(out, Object.fromEntries(steps.map((s) => [s.label, plus])));
    // The vault is asked for no value.
    assert.deepEqual(sealed.requests, []);
  });
});
