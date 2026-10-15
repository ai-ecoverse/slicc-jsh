import http from 'node:http'; import net from 'node:net'; import { once } from 'node:events';
const srv = http.createServer((q, s) => s.end('pong ' + q.url)); srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
const body = await new Promise((r, j) => http.get({ host: '127.0.0.1', port: srv.address().port, path: '/x' }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => r(b)); }).on('error', j));
console.log('http', body); srv.close();
const ns = net.createServer((s) => s.end('net-hi')); ns.listen(0, '127.0.0.1'); await once(ns, 'listening');
const c = net.connect(ns.address().port, '127.0.0.1'); let d = ''; c.on('data', (x) => (d += x)); await once(c, 'end'); console.log('net', d); ns.close();
