const net = require('net'), http = require('http');
const srv = net.createServer((s) => { s.once('data', () => { s.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\npart1-'); setTimeout(() => { s.end('part2-end'); }, 30); }); });
srv.listen(0, '127.0.0.1', () => {
  http.get({ host: '127.0.0.1', port: srv.address().port, path: '/' }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { console.log('close-framed', res.statusCode, res.headers['content-length'], res.headers['transfer-encoding'], JSON.stringify(b)); srv.close(); }); }).on('error', (e) => console.log('ERR', e.code, e.message));
});
