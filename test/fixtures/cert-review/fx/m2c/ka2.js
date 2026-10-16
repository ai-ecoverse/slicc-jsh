// keep-alive without maxSockets, and default agent sequential requests
const http = require('http'); let conns = 0;
const srv = http.createServer((req, res) => res.end('ok' + req.url)); srv.on('connection', () => conns++);
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port; const agent = new http.Agent({ keepAlive: true }); const out = [];
  for (const p of ['/a', '/b', '/c']) await new Promise((r) => http.get({ host: '127.0.0.1', port, path: p, agent }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { out.push(`${b} reused=${res.req.reusedSocket} conn=${res.headers.connection}`); r(); }); }).on('error', (e) => { out.push('err ' + e.code); r(); }));
  console.log(out.join(' | '), 'server connections', conns); agent.destroy(); srv.close();
});
