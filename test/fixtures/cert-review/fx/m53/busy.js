const http = require('http');
const srv = http.createServer((req, res) => setTimeout(() => res.end('slow-done ' + req.url), 700));
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port; const ev = [];
  const go = (l, agent) => new Promise((r) => http.get({ host: '127.0.0.1', port, path: '/' + l, agent }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { ev.push(`${l}:${b}`); r(); }); }).on('error', (e) => { ev.push(`${l}:ERR ${e.code} ${e.message}`); r(); }));
  const ka = new http.Agent({ keepAlive: true });
  const p = Promise.all([go('ka', ka), go('noka', false), go('global', undefined)]);
  setTimeout(() => srv.close(() => ev.push('close-cb')), 200);
  p.then(() => setTimeout(() => { console.log(ev.join(' | ')); ka.destroy(); }, 100));
});
