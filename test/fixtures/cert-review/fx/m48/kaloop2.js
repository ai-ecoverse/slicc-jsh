const http = require('http');
const srv = http.createServer((req, res) => res.end('ok' + req.url));
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const agent = new http.Agent({ keepAlive: true });
  const one = (l, a) => new Promise((r) => { const t = setTimeout(() => { console.log(l, 'stuck'); r(); }, 2000); http.get({ host: '127.0.0.1', port, path: '/' + l, agent: a }, (res) => { res.resume(); res.on('end', () => { clearTimeout(t); console.log(l, res.statusCode); r(); }); }).on('error', (e) => { clearTimeout(t); console.log(l, 'err', e.code); r(); }); });
  await one('ka-unlimited-1', agent); await one('ka-unlimited-2', agent);
  const a1 = new http.Agent({ maxSockets: 1 }); await one('noka-max1-1', a1); await one('noka-max1-2', a1);
  const g = http.globalAgent; console.log('globalAgent keepAlive', g.keepAlive, g.maxSockets);
  await one('global-1', undefined); await one('global-2', undefined); await one('global-3', undefined);
  await Promise.all([1, 2, 3, 4, 5, 6].map((i) => one('par-max1-' + i, new http.Agent({ keepAlive: true, maxSockets: 1 }))));
  const sh = new http.Agent({ keepAlive: true, maxSockets: 2 }); await Promise.all([1, 2, 3, 4].map((i) => one('shared-max2-' + i, sh)));
  agent.destroy(); srv.close(); setTimeout(() => process.exit(0), 50);
});
