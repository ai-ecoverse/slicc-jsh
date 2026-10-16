const http = require('http');
const srv = http.createServer((req, res) => {
  const parts = []; req.on('data', (c) => parts.push(c.length)); req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('one,'); setTimeout(() => { res.write('two,'); res.end('three'); }, 20);
    console.log('server got te=%s cl=%s chunks=%d total=%d', req.headers['transfer-encoding'], req.headers['content-length'], parts.length > 0 ? 1 : 0, parts.reduce((a, b) => a + b, 0));
  });
});
srv.listen(0, '127.0.0.1', () => {
  const req = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', path: '/up' }, (res) => {
    const seen = []; res.on('data', (c) => seen.push(c.toString())); res.on('end', () => { console.log('client te=%s body=%s', res.headers['transfer-encoding'], seen.join('')); srv.close(); });
  });
  req.write('a'.repeat(1000)); setTimeout(() => { req.write('b'.repeat(70000)); req.end('c'); }, 10);
});
