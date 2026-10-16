const http = require('node:http'); const { once } = require('node:events');
const srv = http.createServer((q, s) => s.end('pong')); srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
const b = await new Promise((r, j) => http.get({ host: '127.0.0.1', port: srv.address().port }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => r(d)); }).on('error', j));
console.log('http', b); srv.close();
