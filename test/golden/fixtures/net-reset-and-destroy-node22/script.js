const net = require('net');

const row = (label, act) =>
  new Promise((resolve) => {
    const ev = [];
    const peer = [];
    let got = '';
    const srv = net.createServer((s) => {
      s.on('error', (e) => peer.push(`error ${e.code} ${e.syscall}`));
      s.on('end', () => peer.push('end'));
      s.on('data', (d) => {
        got += d;
        s.write('ok');
      });
      s.on('close', (hadError) => {
        peer.push(`close ${hadError}`);
        srv.close(() => setImmediate(() => {
          console.log(`${label} | ${ev.join(', ')} | the peer got ${JSON.stringify(got)}: ${peer.join(', ')}`);
          resolve();
        }));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      c.on('error', (e) => ev.push(`error ${e.code}`));
      c.on('close', (...args) => ev.push(`close ${JSON.stringify(args)}, destroyed ${c.destroyed}`));
      act(c, ev);
    });
  });

(async () => {
  console.log(`resetAndDestroy is a ${typeof net.Socket.prototype.resetAndDestroy}`);
  await row('connected', (c, ev) =>
    c.on('connect', () => {
      const r = c.resetAndDestroy();
      ev.push(`returns the socket ${r === c}, destroyed ${c.destroyed}`);
    })
  );
  await row('still connecting', (c, ev) => {
    c.resetAndDestroy();
    ev.push(`connecting ${c.connecting}, destroyed ${c.destroyed}`);
    c.on('connect', () => ev.push('connect'));
  });
  await row('reset twice', (c, ev) =>
    c.on('connect', () => {
      c.resetAndDestroy();
      c.resetAndDestroy();
      ev.push(`destroyed ${c.destroyed}`);
    })
  );
  await row('reset once the peer has read what was written', (c, ev) => {
    c.on('connect', () => c.write('hello'));
    c.on('data', () => {
      c.resetAndDestroy();
      ev.push(`destroyed ${c.destroyed}`);
    });
  });
  await row('destroyed, then reset', (c, ev) =>
    c.on('connect', () => {
      c.destroy();
      ev.push(`returns the socket ${c.resetAndDestroy() === c}`);
    })
  );
  await new Promise((resolve) => {
    const ev = [];
    const s = new net.Socket();
    s.on('error', (e) => ev.push(`error ${e.code} ${e.message}`));
    s.on('close', (...args) => {
      ev.push(`close ${JSON.stringify(args)}`);
      setImmediate(() => {
        console.log(`a socket without a connection | ${ev.join(', ')}`);
        resolve();
      });
    });
    ev.push(`returns the socket ${s.resetAndDestroy() === s}, destroyed ${s.destroyed}`);
  });
  console.log('done');
})();
