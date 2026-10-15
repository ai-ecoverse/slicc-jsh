// jsh http client → raw net server: what bytes does a chunked POST put on the wire?
const net = require('net'), http = require('http');
const srv = net.createServer((s) => { let buf = ''; s.on('data', (d) => { buf += d.toString('latin1'); if (/0\r\n\r\n$/.test(buf) || buf.length > 80000) { console.log('wire head:', JSON.stringify(buf.split('\r\n\r\n')[0])); console.log('wire body bytes:', buf.length - buf.indexOf('\r\n\r\n') - 4, 'ends with 0-chunk:', /0\r\n\r\n$/.test(buf)); s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'); } }); });
srv.listen(0, '127.0.0.1', () => {
  const req = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', path: '/up' }, (res) => { res.resume(); res.on('end', () => { console.log('client done', res.statusCode); srv.close(); }); });
  req.write('a'.repeat(10)); setTimeout(() => { req.write('b'.repeat(20)); req.end('c'); }, 10);
});
setTimeout(() => { console.log('timeout'); process.exit(1); }, 5000).unref();
