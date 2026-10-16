const net = require('net'); const ev = { server: [], client: [] };
const srv = net.createServer({ allowHalfOpen: true }, (s) => { s.on('end', () => { ev.server.push('end'); s.end('late-bye'); }); s.on('close', () => ev.server.push('close')); s.resume(); });
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1', () => c.end('ping')); let d = '';
  c.on('data', (x) => (d += x)); c.on('end', () => ev.client.push('end')); c.on('close', () => ev.client.push('close'));
  setTimeout(() => { console.log('halfopen: client', ev.client.join(','), 'got', d, '| server', ev.server.join(',')); srv.close(); }, 500);
});
