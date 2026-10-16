console.log('start');
const net = require('net');
const hs = require('http').createServer();
console.log('http.Server allowHalfOpen', hs.allowHalfOpen, 'net default', new net.Socket().allowHalfOpen);
const srv = net.createServer((s) => {
  console.log('server conn');
  const ev = [];
  s.on('end', () => { ev.push('end'); console.log('server end'); });
  s.on('close', (h) => { ev.push('close:' + h); console.log('server close', ev.join(',')); });
  s.write('hello');
  s.end();
});
srv.listen(0, '127.0.0.1', () => {
  console.log('listening');
  const c = net.connect(srv.address().port, '127.0.0.1');
  const ev = [];
  let data = '';
  c.on('connect', () => console.log('client connect'));
  c.on('data', (d) => { data += d; console.log('client data'); });
  c.on('end', () => { ev.push('end'); console.log('client end'); });
  c.on('finish', () => { ev.push('finish'); console.log('client finish'); });
  c.on('close', (h) => {
    ev.push('close:' + h);
    console.log('client close', ev.join(','), data);
    setTimeout(() => { console.log('exit'); process.exit(0); }, 100);
  });
});
setTimeout(() => { console.log('bail'); process.exit(3); }, 2000);
