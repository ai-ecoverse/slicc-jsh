const http = require('http');
const srv = http.createServer((req, res) => { if (req.url === '/slow') return setTimeout(() => res.end('slow-done'), 700); res.end('ok'); });
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port; const ev = [];
  const agent = new http.Agent({ keepAlive: true });
  http.get({ host: '127.0.0.1', port, path: '/first', agent }, (res) => { res.resume(); res.on('end', () => {
    http.get({ host: '127.0.0.1', port, path: '/slow', agent }, (r2) => { let b = ''; r2.on('data', (c) => (b += c)); r2.on('end', () => { ev.push('slow:' + b); }); }).on('error', (e) => ev.push('slow:ERR ' + e.message));
    setTimeout(() => srv.close(() => ev.push('close-cb')), 200);
    setTimeout(() => { console.log(ev.join(' | ')); agent.destroy(); }, 1500);
  }); });
});
