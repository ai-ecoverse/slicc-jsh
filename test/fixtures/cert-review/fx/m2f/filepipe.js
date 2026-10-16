const http = require('http'), fs = require('fs');
fs.writeFileSync('/tmp/up.bin', Buffer.alloc(3 * 1024 * 1024, 7));
const srv = http.createServer((req, res) => { let n = 0; req.on('data', (c) => (n += c.length)); req.on('end', () => res.end(`cl=${req.headers['content-length']} te=${req.headers['transfer-encoding']} got=${n}`)); });
srv.listen(0, '127.0.0.1', () => {
  const q = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'PUT', path: '/' }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { console.log('fs.createReadStream(3 MiB).pipe(req) →', b); srv.close(); }); });
  fs.createReadStream('/tmp/up.bin').pipe(q);
});
