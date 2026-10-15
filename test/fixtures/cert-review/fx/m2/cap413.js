const http = require('http');
const CAP = 64 * 1024;
const srv = http.createServer((req, res) => {
  let n = 0; let done = false;
  req.on('data', (c) => { n += c.length; if (n > CAP && !done) { done = true; res.writeHead(413, { connection: 'close' }); res.end('too big'); req.destroy(); } });
  req.on('end', () => { if (!done) res.end('ok ' + n); });
});
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  for (const size of [1000, 200000]) await new Promise((r) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-length': size } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { console.log(size, '→', res.statusCode, b); r(); }); });
    req.on('error', (e) => { console.log(size, '→ client error', e.code); r(); });
    req.end(Buffer.alloc(size, 120));
  });
  srv.close();
});
