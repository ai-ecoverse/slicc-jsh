const fs = require('fs'); const cp = require('child_process'); const net = require('net'); const dns = require('dns'); const zlib = require('zlib'); const crypto = require('crypto');
const results = [];
const probe = (label) => { const log = []; process.nextTick(() => log.push('tick')); Promise.resolve().then(() => log.push('micro')); setImmediate(() => results.push(`${label}: ${log.join(', ')}`)); };
const steps = [
  (n) => fs.readFile(__filename, () => { probe('fs.readFile'); setImmediate(n); }),
  (n) => fs.stat(__filename, () => { probe('fs.stat'); setImmediate(n); }),
  (n) => fs.promises.stat(__filename).then(() => { probe('fs.promises'); setImmediate(n); }),
  (n) => setTimeout(() => { probe('setTimeout'); setImmediate(n); }, 1),
  (n) => setImmediate(() => { probe('setImmediate'); setImmediate(n); }),
  (n) => { const c = cp.spawn(process.execPath, ['-e', 'console.log(1)']); c.stdout.on('data', () => probe('child stdout data')); c.on('exit', () => probe('child exit')); c.on('close', () => { probe('child close'); setImmediate(n); }); },
  (n) => dns.lookup('localhost', () => { probe('dns.lookup'); setImmediate(n); }),
  (n) => zlib.gzip('x', () => { probe('zlib.gzip'); setImmediate(n); }),
  (n) => crypto.randomBytes(4, () => { probe('crypto.randomBytes'); setImmediate(n); }),
  (n) => { const srv = net.createServer((s) => { probe('server connection'); s.on('data', () => { probe('server data'); s.end('y'); }); }); srv.listen(0, '127.0.0.1', () => { probe('listen'); const c = net.connect(srv.address().port, '127.0.0.1', () => { probe('connect'); c.write('x'); }); c.on('data', () => probe('client data')); c.on('end', () => probe('client end')); c.on('close', () => { probe('client close'); srv.close(() => { probe('server close'); setImmediate(n); }); }); }); },
];
const go = () => { const s = steps.shift(); if (s) s(go); else setTimeout(() => console.log(results.sort().join('\n')), 20); };
go();
