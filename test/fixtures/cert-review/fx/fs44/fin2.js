const net = require('net'); const ev = { server: [], client: [] };
const srv = net.createServer((s) => { s.on('end', () => ev.server.push('end')); s.on('close', () => { ev.server.push('close'); }); s.write('hello'); s.end(); });
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1'); let data = '';
  c.on('data', (d) => (data += d)); c.on('end', () => ev.client.push('end')); c.on('close', (h) => ev.client.push('close:' + h));
  setTimeout(() => { console.log('after 500 ms: client', ev.client.join(','), '| server', ev.server.join(','), '| data', data); srv.close(); }, 500);
});
