// multi-write request bodies: with content-length, without, sync vs async writes; json PUT
const http = require('http');
const srv = http.createServer((req, res) => { let n = 0, s = ''; req.on('data', (c) => { n += c.length; s += c; }); req.on('end', () => res.end(`${req.method} cl=${req.headers['content-length']} te=${req.headers['transfer-encoding']} got=${n} tail=${s.slice(-3)}`)); });
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const go = (name, headers, writer) => new Promise((r) => { const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { console.log(name.padEnd(36), '→', b); r(); }); }); req.on('error', (e) => { console.log(name, 'error', e.code); r(); }); writer(req); });
  await go('3 sync writes, no length', {}, (q) => { q.write('aaa'); q.write('bbb'); q.end('ccc'); });
  await go('3 async writes, no length', {}, (q) => { q.write('aaa'); setTimeout(() => { q.write('bbb'); setTimeout(() => q.end('ccc'), 10); }, 10); });
  await go('3 async writes, content-length 9', { 'content-length': 9 }, (q) => { q.write('aaa'); setTimeout(() => { q.write('bbb'); setTimeout(() => q.end('ccc'), 10); }, 10); });
  await go('end(body) only', {}, (q) => q.end('xyz'));
  await go('stream pipe 200 KB, no length', {}, (q) => { const { Readable } = require('stream'); Readable.from([Buffer.alloc(100000, 97), Buffer.alloc(100000, 98)]).pipe(q); });
  const a = new http.Agent({ keepAlive: true }); console.log('Agent methods:', ['destroy', 'getName', 'createConnection', 'keepSocketAlive'].map((m) => `${m}:${typeof a[m]}`).join(' '), 'globalAgent', typeof http.globalAgent);
  srv.close();
});
