// incremental response: does the client see events as they're written?
const http = require('http'); const t0 = Date.now();
const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); let i = 0; const iv = setInterval(() => { res.write(`data: ${i}\n\n`); if (++i === 5) { clearInterval(iv); res.end(); } }, 200); });
srv.listen(0, '127.0.0.1', () => http.get({ host: '127.0.0.1', port: srv.address().port }, (res) => { const at = []; res.on('data', (c) => at.push(Math.round((Date.now() - t0) / 100) / 10 + 's:' + c.toString().split('\n\n').filter(Boolean).length)); res.on('end', () => { console.log('arrivals', at.join(' '), 'te', res.headers['transfer-encoding'], 'cl', res.headers['content-length']); srv.close(); }); }));
