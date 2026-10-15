const net = require('net'); const ev = { server: [], client: [] };
const srv = net.createServer((s) => { s.on('data', (d) => ev.server.push('data:' + d)); s.on('end', () => { ev.server.push('end'); s.end('bye'); }); s.on('close', () => ev.server.push('close')); });
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1', () => { c.write('ping'); c.end(); }); let data = '';
  c.on('data', (d) => (data += d)); c.on('end', () => ev.client.push('end')); c.on('close', (h) => ev.client.push('close:' + h));
  setTimeout(() => { console.log('client-initiated FIN after 500 ms: client', ev.client.join(','), '| server', ev.server.join(','), '| client got', data, '| server connections', srv._connections ?? '?'); srv.close(); }, 500);
});
