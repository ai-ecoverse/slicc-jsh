const net = require('net');

const row = (label, act) =>
  new Promise((resolve) => {
    const peer = [];
    const own = [];
    const srv = net.createServer((s) => {
      s.on('error', (e) => peer.push(`error ${e.code} ${e.syscall}`));
      s.on('end', () => peer.push('end'));
      s.on('data', (d) => peer.push(`data ${JSON.stringify(String(d))}`));
      s.on('close', (hadError) => {
        peer.push(`close ${hadError}`);
        srv.close(() =>
          setImmediate(() => {
            console.log(label);
            console.log(`  peer: ${peer.join(', ')}`);
            console.log(`  socket: ${own.join(', ')}`);
            resolve();
          })
        );
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1', () => setTimeout(() => act(c), 50));
      c.on('error', (e) => own.push(`error ${e.code}`));
      c.on('close', (hadError) => own.push(`close ${hadError}`));
    });
  });

(async () => {
  await row('write, then reset in the same tick', (c) => {
    c.write('hello');
    c.resetAndDestroy();
  });
  await row('write, then reset in a later timer', (c) => {
    c.write('hello');
    setTimeout(() => c.resetAndDestroy(), 50);
  });
  await row('reset with nothing written', (c) => c.resetAndDestroy());
  console.log('done');
})();
