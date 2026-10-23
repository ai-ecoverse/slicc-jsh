const net = require('net');

const run = (label, clients, next) => {
  const log = [];
  let open = clients.length;
  const srv = net.createServer((s) => {
    log.push('connection');
    s.end();
  });
  srv.listen(0, '127.0.0.1', () => {
    for (const name of clients) {
      const c = net.connect(srv.address().port, '127.0.0.1', () => {
        log.push(`connect ${name}`);
      });
      c.on('close', () => {
        if (--open === 0) {
          console.log(`${label}: ${log.join(', ')}`);
          srv.close(next);
        }
      });
    }
  });
};

const order = (label, next) => {
  const log = [];
  const srv = net.createServer((s) => {
    log.push('server connection');
    s.end();
  });
  srv.listen(0, '127.0.0.1', () => {
    const c = net.connect(srv.address().port, '127.0.0.1', () => log.push('client connect'));
    c.on('close', () => {
      console.log(`${label}: ${log.join(', ')}`);
      srv.close(next);
    });
  });
};

order('one client', () => order('again', () => run('two clients', ['a', 'b'], () => {})));
