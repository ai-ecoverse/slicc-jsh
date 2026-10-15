const http = require('http');
let conns = 0;
const srv = http.createServer((req, res) => { res.setHeader('x-n', req.url); res.end('ok ' + req.url); });
srv.on('connection', () => conns++);
srv.listen(0, '127.0.0.1', async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const port = srv.address().port; const out = [];
  for (const p of ['/a', '/b', '/c']) {
    await new Promise((r, j) => http.get({ host: '127.0.0.1', port, path: p, agent }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => { out.push(`${res.statusCode} ${b} reused=${res.req.reusedSocket} conn=${res.headers.connection} ka=${res.headers['keep-alive']}`); r(); }); }).on('error', j));
  }
  console.log(out.join('\n')); console.log('server connections', conns);
  agent.destroy(); srv.close(() => console.log('closed'));
});
