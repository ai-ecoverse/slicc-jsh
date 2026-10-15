const http = require('http');
const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => setTimeout(() => res.end('echo:' + b), 20)); });
srv.listen(0, '127.0.0.1', () => { const r = http.request({ port: srv.address().port, host: '127.0.0.1', method: 'POST' }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { console.log(res.statusCode, d); srv.close(); }); }); r.end('x'); });
