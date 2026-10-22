const net = require('net');
const srv = net.createServer((s) => {
  s.write('pay');
  s.once('data', () => s.end('load'));
});
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1');
  const events = [];
  c.once('data', (d) => {
    c.pause();
    console.log('first', String(d), 'readableFlowing', c.readableFlowing);
    c.write('ack');
    wait();
  });
  c.on('end', () => events.push('end'));
  c.on('close', () => {
    events.push('close');
    console.log('events', events.join(' '), 'readableEnded', c.readableEnded);
    srv.close(() => console.log('server closed'));
  });
  const wait = () => {
    if (!(c._readableState.ended && c.readableLength === 4)) return setImmediate(wait);
    setImmediate(() =>
      setImmediate(() => {
        console.log('at EOF: buffered', c.readableLength, 'readableEnded', c.readableEnded, 'events', JSON.stringify(events.join(' ')));
        console.log('read', String(c.read()));
      })
    );
  };
});
