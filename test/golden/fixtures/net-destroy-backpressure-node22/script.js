const net = require('net');
const log = (...a) => console.log(...a);
const paused = () => new Promise((resolve) => {
  const srv = net.createServer((s) => {
    s.on('error', () => {});
    const ok = s.write(Buffer.alloc(1024 * 1024, 97));
    log('a 1 MiB write to a paused peer: write returned', ok);
    s.once('data', () => {
      s.destroy();
      log('destroyed', s.destroyed);
    });
    s.on('close', () => {
      log('server close');
      srv.close(() => {
        log('server closed');
        resolve();
      });
    });
  });
  srv.listen(0, '127.0.0.1', () => {
    const c = net.connect(srv.address().port, '127.0.0.1');
    c.on('error', () => {});
    c.pause();
    c.on('connect', () => setTimeout(() => c.write('go'), 50));
    srv.once('close', () => c.destroy());
  });
});
const big = () => new Promise((resolve) => {
  const srv = net.createServer((s) => {
    s.on('error', () => {});
    s.write(Buffer.alloc(16 * 1024 * 1024));
    s.destroy();
    srv.close(() => {
      log('a 16 MiB write, then destroy: server closed');
      resolve();
    });
  });
  srv.listen(0, '127.0.0.1', () => {
    const c = net.connect(srv.address().port, '127.0.0.1');
    c.on('error', () => {});
    c.unref();
  });
});
(async () => {
  await paused();
  await big();
})();
process.on('exit', () => log('exit'));
