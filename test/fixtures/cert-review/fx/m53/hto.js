const http = require('http'), net = require('net'); const t0 = Date.now();
const srv = http.createServer({ headersTimeout: 800, requestTimeout: 800, connectionsCheckingInterval: 200 }, (q, r) => r.end('x'));
console.log('opts', srv.headersTimeout, srv.requestTimeout);
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1', () => c.write('GET /x HTTP/1.1\r\nHost: x\r\n')); let b = '';
  c.on('data', (d) => (b += d)); c.on('close', () => { console.log('closed after', Math.round((Date.now() - t0) / 1000), 's', JSON.stringify(b.split('\r\n')[0])); srv.close(); process.exit(0); });
  setTimeout(() => { console.log('no close in 40s'); process.exit(0); }, 40000);
});
