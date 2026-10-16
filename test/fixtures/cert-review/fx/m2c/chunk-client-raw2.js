const net = require('net'), http = require('http');
const t0 = Date.now(); const log = (...a) => console.log(`[${Math.round((Date.now() - t0) / 100) * 100}ms]`, ...a);
const srv = net.createServer((s) => { s.on('data', (d) => log('server recv', JSON.stringify(d.toString('latin1').slice(0, 160)), d.length)); s.on('end', () => log('server got FIN')); setTimeout(() => { s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'); }, 1500); });
srv.listen(0, '127.0.0.1', () => {
  const req = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', path: '/up' }, (res) => { res.resume(); res.on('end', () => { log('client done', res.statusCode); srv.close(); }); });
  req.on('error', (e) => log('client error', e.code));
  req.write('a'.repeat(10)); setTimeout(() => { req.write('b'.repeat(20)); req.end('c'); log('client end() called'); }, 10);
});
setTimeout(() => { log('timeout'); process.exit(1); }, 4000);
