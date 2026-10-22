const net = require('net');
const srv = net.createServer((s) => {
  s.once('data', (d) =>
    setImmediate(() => {
      console.log('server got', String(d), 'and unrefs');
      s.unref();
      s.write('ack');
    })
  );
});
srv.listen(0, '127.0.0.1', () => {
  srv.unref();
  const c = net.connect(srv.address().port, '127.0.0.1', () => c.write('hi'));
  c.once('data', (d) =>
    setImmediate(() => {
      c.unref();
      console.log('client got', String(d), 'and unrefs; both still reading');
    })
  );
});
process.on('exit', () => console.log('exit, server listening', srv.listening));
