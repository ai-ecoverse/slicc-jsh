const net = require('net');

const s = net.createServer((socket) => socket.end('hi'));
s.listen(0, '127.0.0.1', () => {
  const h = s._handle;
  console.log('methods', ['getsockname', 'close', 'ref', 'unref', 'hasRef'].map((m) => typeof h[m]).join(' '), typeof h.fd, h.reading);
  const out = {};
  console.log('getsockname', h.getsockname(out), Object.keys(out).join(','), JSON.stringify(out) === JSON.stringify(s.address()));
  console.log('hasRef', h.hasRef());
  s.unref();
  console.log('server unref', h.hasRef());
  s.ref();
  console.log('server ref', h.hasRef());
  h.unref();
  console.log('handle unref', h.hasRef());
  h.ref();
  console.log('handle ref', h.hasRef());
  const port = s.address().port;
  net.connect(port, '127.0.0.1').on('data', (d) => {
    console.log('still accepting', String(d));
    const report = (when) => {
      const out = {};
      let address;
      try {
        address = JSON.stringify(s.address());
      } catch (e) {
        address = [e.code, e.errno, e.syscall, e.message].join(' ');
      }
      console.log(when, 'getsockname', h.getsockname(out), JSON.stringify(out), 'address', address, 'hasRef', h.hasRef());
    };
    console.log('close returns', h.close(() => {
      report('closed:');
      console.log('handle closed, listening', s.listening, s._handle === h);
      net.connect(port, '127.0.0.1').on('error', (e) => {
        console.log('after the handle closed', e.code);
        s.close(() => {
          console.log('server closed', s.listening, s._handle);
          idle();
        });
      });
    }));
    report('closing:');
  });
});

function idle() {
  const i = net.createServer();
  i.listen(0, '127.0.0.1', () => {
    i._handle.unref();
    console.log('an unref handle lets the program end', i.listening);
  });
}
process.on('exit', (code) => console.log('exit', code));
