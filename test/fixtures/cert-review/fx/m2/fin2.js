console.log('start');
const net = require('net');
console.log('net ok', typeof net.createServer);
const hs = require('http').createServer();
console.log('http.Server allowHalfOpen', hs.allowHalfOpen, 'net default', new net.Socket().allowHalfOpen);
const srv = net.createServer((s) => {
  console.log('server conn');
  s.write('hello');
  s.end();
  s.on('end', () => console.log('server end'));
  s.on('close', (h) => console.log('server close', h));
});
srv.listen(0, '127.0.0.1', () => {
  console.log('listening', srv.address().port);
  const c = net.connect(srv.address().port, '127.0.0.1');
  const ev = [];
  let data = '';
  c.on('connect', () => console.log('client connect'));
  c.on('data', (d) => { data += d; console.log('client data', d.toString()); });
  c.on('end', () => { ev.push('end'); console.log('client end'); });
  c.on('finish', () => { ev.push('finish'); console.log('client finish'); });
  c.on('close', (h) => { ev.push('close:' + h); console.log('client close', ev.join(','), data); srv.close(() => console.log('srv closed')); });
  c.on('error', (e) => console.log('client err', e.message));
});
setTimeout(() => { console.log('timeout bail'); process.exit(3); }, 3000).unref?.();
