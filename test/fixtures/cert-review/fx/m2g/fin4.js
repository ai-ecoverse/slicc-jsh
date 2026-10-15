const net = require('net'); const ev = { server: [], client: [] };
const srv = net.createServer((s) => { s.on('data', (d) => ev.server.push('data:' + d)); s.on('end', () => ev.server.push('end')); s.on('finish', () => ev.server.push('finish')); s.on('close', (h) => ev.server.push('close:' + h)); });
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1', () => { c.write('ping'); c.end(); });
  c.on('end', () => ev.client.push('end')); c.on('finish', () => ev.client.push('finish')); c.on('close', (h) => ev.client.push('close:' + h));
  setTimeout(() => { console.log('client', ev.client.join(','), '| server', ev.server.join(',')); srv.close(); }, 500);
});
