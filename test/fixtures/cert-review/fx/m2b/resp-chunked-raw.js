// jsh http server streaming response → raw client: is it chunked on the wire?
const net = require('net'), http = require('http');
const srv = http.createServer((req, res) => { res.write('one,'); setTimeout(() => res.end('two'), 20); });
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1', () => c.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
  let r = ''; c.on('data', (d) => (r += d)); c.on('end', () => { console.log('wire:', JSON.stringify(r.replace(/Date: [^\r]*\r\n/, ''))); srv.close(); });
});
