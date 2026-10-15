const http = require('http');
const srv = http.createServer((req, res) => res.end('ok'));
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  for (let i = 0; i < 3; i++) await new Promise((r) => http.get(`http://127.0.0.1:${port}/${i}`, (res) => { res.resume(); res.on('end', r); }));
  await fetch(`http://127.0.0.1:${port}/f`).then((r) => r.text());
  srv.close(() => console.log('server closed'));
});
process.on('exit', () => console.log('exit'));
