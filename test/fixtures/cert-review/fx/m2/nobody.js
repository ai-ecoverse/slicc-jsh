const http = require('http');
const srv = http.createServer((req, res) => {
  if (req.url === '/204') { res.writeHead(204); return res.end(); }
  if (req.url === '/304') { res.writeHead(304, { etag: '"x"' }); return res.end(); }
  res.writeHead(200, { 'content-length': 5, 'content-type': 'text/plain' }); res.end(req.method === 'HEAD' ? undefined : 'hello');
});
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port; const out = [];
  for (const [m, p] of [['HEAD', '/'], ['GET', '/204'], ['GET', '/304'], ['GET', '/']]) await new Promise((r) => http.request({ host: '127.0.0.1', port, method: m, path: p }, (res) => { let n = 0; res.on('data', (c) => (n += c.length)); res.on('end', () => { out.push(`${m} ${p} → ${res.statusCode} cl=${res.headers['content-length']} bodyBytes=${n}`); r(); }); }).end());
  console.log(out.join('\n')); srv.close();
});
