const http = require('http');
const srv = http.createServer((req, res) => { let n = 0, s = ''; req.on('data', (c) => { n += c.length; s += c; }); req.on('end', () => res.end(`cl=${req.headers['content-length']} te=${req.headers['transfer-encoding']} got=${n} tail=${s.slice(-3)}`)); });
srv.listen(0, '127.0.0.1', () => { const q = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', path: '/', headers: {} }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { console.log('endonly →', b); srv.close(); }); }); q.on('error', (e) => { console.log('endonly error', e.code); srv.close(); }); q.end('xyz'); });
setTimeout(() => { console.log('endonly: no response in 4 s'); process.exit(2); }, 4000).unref?.();
