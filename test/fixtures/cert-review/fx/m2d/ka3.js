const http = require('http'); let conns = 0;
const srv = http.createServer((req, res) => res.end('ok' + req.url)); srv.on('connection', () => conns++);
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port; const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); const out = [];
  for (const p of ['/a', '/b', '/c']) await new Promise((r) => { const req = http.get({ host: '127.0.0.1', port, path: p, agent }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { out.push(`${b} reused=${req.reusedSocket} conn=${res.headers.connection} res.req=${typeof res.req}`); r(); }); }); req.on('error', (e) => { out.push('err ' + e.code); r(); }); });
  console.log(out.join(' | ')); console.log('server connections', conns); agent.destroy(); srv.close();
});
