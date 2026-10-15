// raw net client sends a chunked POST → jsh http server
const net = require('net'), http = require('http');
const srv = http.createServer((req, res) => { let n = 0; req.on('data', (c) => (n += c.length)); req.on('end', () => { console.log('server te=%s total=%d', req.headers['transfer-encoding'], n); res.end('got ' + n); }); });
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1', () => c.write('POST /x HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\na\r\n0123456789\r\n5\r\nabcde\r\n0\r\n\r\n'));
  let r = ''; c.on('data', (d) => (r += d)); c.on('end', () => { console.log('raw client got', JSON.stringify(r.split('\r\n\r\n')[0].split('\r\n')[0]), JSON.stringify(r.split('\r\n\r\n')[1])); srv.close(); });
});
