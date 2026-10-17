import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devPackageTree, kernelAtLeast, withJsh } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const version = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

// got and ioredis require dns at load (got through cacheable-lookup, and
// http2 too). The golden dns-node22 pins the module's surface against Node;
// here are the kernel's answers and the real packages in a kernel program.
// slicc-kernel 1.113.0 gives JS programs its resolver (ctx.net.resolve,
// ai-ecoverse/slicc-kernel#913): lookup, resolve4 and resolve6 ask it, so
// /etc/hosts answers too. Before that, jsh answers the kernel's own names
// and a query finds no nameserver.
const resolver = kernelAtLeast('1.113.0');
describe('dns (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    for (const name of ['got', 'ioredis']) {
      for (const [path, data] of devPackageTree(name)) await jsh.kernel.writeFile(`/os${path}`, data);
    }
  });
  after(() => jsh?.close());

  it("lookup answers the kernel's names (and /etc/hosts through its resolver); any other name is getaddrinfo ENOTFOUND", async () => {
    await jsh.kernel.writeFile('/etc/hosts', '127.0.0.1 localhost\n::1 localhost ip6-localhost\n10.9.8.7 db.example.test\n');
    await jsh.kernel.writeFile(
      '/os/dns-lookup.mjs',
      `import dns from 'node:dns';
import dnsp from 'node:dns/promises';
import { promisify } from 'node:util';
const cb = (label, f) => new Promise((resolve) => f((err, ...rest) => {
  console.log(label, err ? [err.message, err.code, err.errno, err.syscall, err.hostname, Object.keys(err).join()].join(' | ') : JSON.stringify(rest));
  resolve();
}));
await cb('localhost', (f) => dns.lookup('localhost', f));
await cb('localhost all', (f) => dns.lookup('localhost', { all: true }, f));
await cb('localhost 6', (f) => dns.lookup('localhost', 6, f));
await cb('ipv6first', (f) => dns.lookup('LocalHost.', { all: true, order: 'ipv6first' }, f));
await cb('app.localhost', (f) => dns.lookup('app.localhost', f));
await cb('own name', (f) => dns.lookup('slicc', 4, f));
await cb('host loopback', (f) => dns.lookup('host.slicc.internal', f));
await cb('other name', (f) => dns.lookup('nothing.invalid', f));
await cb('other name all', (f) => dns.lookup('nothing.invalid', { all: true }, f));
await cb('/etc/hosts', (f) => dns.lookup('db.example.test', f));
await cb('resolve4 /etc/hosts', (f) => dns.resolve4('db.example.test', f));
console.log('promises', JSON.stringify(await dnsp.lookup('localhost')), JSON.stringify(await promisify(dns.lookup)('localhost', { all: true })));
await dnsp.lookup('nothing.invalid').catch((e) => console.log('promises other', e.message, e.code, e.errno));
await cb('lookupService', (f) => dns.lookupService('127.0.0.1', 22, f));
await cb('lookupService 6', (f) => dns.lookupService('::1', 4321, f));
console.log('lookupService promises', JSON.stringify(await dnsp.lookupService('127.0.1.1', 443)));
await cb('reverse', (f) => dns.reverse('127.0.0.1', f));
await cb('resolve4', (f) => dns.resolve4('nothing.invalid', f));
await cb('resolveMx', (f) => dns.resolveMx('nothing.invalid', f));
await dnsp.resolveSrv('_mongodb._tcp.nothing.invalid').catch((e) => console.log('promises resolveSrv', e.message, e.code));
console.log('servers', JSON.stringify(dns.getServers()), 'hints', dns.ADDRCONFIG, dns.ALL, dns.V4MAPPED);
`
    );
    const r = await jsh.run(['node', 'dns-lookup.mjs']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    const notFound = 'getaddrinfo ENOTFOUND nothing.invalid | ENOTFOUND | -3008 | getaddrinfo | nothing.invalid | errno,code,syscall,hostname';
    assert.deepEqual(r.stdout.split('\n'), [
      'localhost ["127.0.0.1",4]',
      'localhost all [[{"address":"127.0.0.1","family":4},{"address":"::1","family":6}]]',
      'localhost 6 ["::1",6]',
      'ipv6first [[{"address":"::1","family":6},{"address":"127.0.0.1","family":4}]]',
      'app.localhost ["127.0.0.1",4]',
      'own name ["127.0.1.1",4]',
      'host loopback ["10.0.2.2",4]',
      `other name ${notFound}`,
      `other name all ${notFound}`,
      resolver ? '/etc/hosts ["10.9.8.7",4]' : '/etc/hosts getaddrinfo ENOTFOUND db.example.test | ENOTFOUND | -3008 | getaddrinfo | db.example.test | errno,code,syscall,hostname',
      resolver
        ? 'resolve4 /etc/hosts [["10.9.8.7"]]'
        : 'resolve4 /etc/hosts queryA ECONNREFUSED db.example.test | ECONNREFUSED |  | queryA | db.example.test | errno,code,syscall,hostname',
      'promises {"address":"127.0.0.1","family":4} [{"address":"127.0.0.1","family":4},{"address":"::1","family":6}]',
      'promises other getaddrinfo ENOTFOUND nothing.invalid ENOTFOUND -3008',
      'lookupService ["localhost","ssh"]',
      'lookupService 6 ["localhost","4321"]',
      'lookupService promises {"hostname":"slicc","service":"https"}',
      'reverse [["localhost"]]',
      `resolve4 queryA ${resolver ? 'ENOTFOUND' : 'ECONNREFUSED'} nothing.invalid | ${resolver ? 'ENOTFOUND' : 'ECONNREFUSED'} |  | queryA | nothing.invalid | errno,code,syscall,hostname`,
      'resolveMx queryMx ECONNREFUSED nothing.invalid | ECONNREFUSED |  | queryMx | nothing.invalid | errno,code,syscall,hostname',
      'promises resolveSrv querySrv ECONNREFUSED _mongodb._tcp.nothing.invalid ECONNREFUSED',
      'servers [] hints 32 16 8',
      '',
    ]);
  });

  it('the real got loads (it needs http2 and dns at load) and GETs and POSTs to a loopback server by name', async () => {
    assert.equal(version('got'), '16.1.0');
    await jsh.kernel.writeFile(
      '/os/got-get.mjs',
      `import http from 'node:http';
import got from 'got';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url, body }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://localhost:' + server.address().port;
try {
  console.log('get', JSON.stringify(await got(base + '/a', { searchParams: { x: 1 } }).json()));
  console.log('post', JSON.stringify(await got.post(base + '/b', { json: { k: 'v' } }).json()));
  const res = await got(base + '/c', { dnsCache: true });
  console.log('dnsCache', res.statusCode, JSON.parse(res.body).url);
} catch (e) {
  console.log('error', e.code, e.message);
}
server.close();
`
    );
    const r = await jsh.run(['node', 'got-get.mjs']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.split('\n'), [
      'get {"method":"GET","url":"/a?x=1","body":""}',
      'post {"method":"POST","url":"/b","body":"{\\"k\\":\\"v\\"}"}',
      'dnsCache 200 /c',
      '',
    ]);
  });

  it('the real ioredis loads (it needs dns at load) and talks RESP to a server in the kernel', async () => {
    assert.equal(version('ioredis'), '6.0.0');
    await jsh.kernel.writeFile(
      '/os/ioredis.js',
      `const net = require('net');
const Redis = require('ioredis');
const store = new Map();
const seen = [];
// A small RESP server: arrays of bulk strings in, simple and bulk strings out.
const server = net.createServer((socket) => {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const text = buf.toString('latin1');
      const m = /^\\*(\\d+)\\r\\n/.exec(text);
      if (!m) return;
      let at = m[0].length;
      const args = [];
      for (let i = 0; i < Number(m[1]); i++) {
        const b = /^\\$(\\d+)\\r\\n/.exec(text.slice(at));
        if (!b || text.length < at + b[0].length + Number(b[1]) + 2) return;
        at += b[0].length;
        args.push(text.slice(at, at + Number(b[1])));
        at += Number(b[1]) + 2;
      }
      buf = buf.subarray(at);
      const cmd = args[0].toUpperCase();
      seen.push(cmd);
      if (cmd === 'PING') socket.write('+PONG\\r\\n');
      else if (cmd === 'SET') { store.set(args[1], args[2]); socket.write('+OK\\r\\n'); }
      else if (cmd === 'GET') { const v = store.get(args[1]); socket.write(v === undefined ? '$-1\\r\\n' : '$' + Buffer.byteLength(v) + '\\r\\n' + v + '\\r\\n'); }
      else if (cmd === 'QUIT') { socket.end('+OK\\r\\n'); }
      else socket.write('+OK\\r\\n');
    }
  });
});
server.listen(0, '127.0.0.1', async () => {
  const redis = new Redis({ host: 'localhost', port: server.address().port, enableReadyCheck: false, maxRetriesPerRequest: 0 });
  try {
    console.log('ping', await redis.ping());
    console.log('set', await redis.set('k', 'v'));
    console.log('get', await redis.get('k'), await redis.get('missing'));
    await redis.quit();
  } catch (e) {
    console.log('error', e.code, e.message);
  }
  console.log('commands', seen.filter((c) => ['PING', 'SET', 'GET', 'QUIT'].includes(c)).join(' '));
  server.close();
});
`
    );
    const r = await jsh.run(['node', 'ioredis.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.split('\n'), ['ping PONG', 'set OK', 'get v null', 'commands PING SET GET GET QUIT', '']);
  });
});
