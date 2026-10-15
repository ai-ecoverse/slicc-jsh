const http = require('http');
for (const o of [{ requestTimeout: 800 }, { requestTimeout: 0 }, { requestTimeout: 120000 }, { headersTimeout: 100 }]) { const s = http.createServer(o); console.log(JSON.stringify(o), s.headersTimeout, s.requestTimeout); }
const ev = [];
const server = http.createServer((req, res) => {
  res.write('part ');
  server.close(() => ev.push('close cb'));
  setTimeout(() => res.end('end'), 200);
});
server.listen(0, '127.0.0.1', () => {
  http.get({ port: server.address().port, path: '/s' }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => ev.push('client end ' + JSON.stringify(b))); }).on('error', (e) => ev.push('client error ' + e.message));
});
process.on('exit', () => console.log(ev.join(' | ')));
