const net = require('net');
const srv = net.createServer((s) => { s.write('hello'); s.end(); s.on('close', () => console.log('server socket close')); });
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1');
  const ev = []; let data = '';
  c.on('data', (d) => (data += d)); c.on('end', () => ev.push('end')); c.on('finish', () => ev.push('finish')); c.on('close', (h) => { ev.push('close:' + h); console.log('client events', ev.join(','), 'data', data, 'allowHalfOpen', c.allowHalfOpen, 'writable after', c.writable); srv.close(); });
});
const hs = require('http').createServer(); console.log('http.Server allowHalfOpen', hs.allowHalfOpen ?? hs.httpAllowHalfOpen, 'net default', new net.Socket().allowHalfOpen);
