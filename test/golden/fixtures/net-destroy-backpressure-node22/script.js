const net = require('net');
const log = (...a) => console.log(...a);
const delay = Number(process.env.INJECT_DELAY_MS) || 0;
const later = (fn) => (delay ? setTimeout(fn, delay) : fn());

const paused = () =>
  new Promise((resolve) => {
    const srv = net.createServer((s) => {
      s.on('error', () => {});
      s.on('close', () => {
        log('server close');
        srv.close(() => {
          log('server closed');
          resolve();
        });
      });
      const chunk = Buffer.alloc(64 * 1024, 97);
      while (s.write(chunk));
      log('writes to a paused peer until write() returns false: needDrain', s.writableNeedDrain);
      later(() => {
        s.destroy();
        log('destroyed', s.destroyed);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      c.on('error', () => {});
      c.pause();
      srv.once('close', () => c.destroy());
    });
  });

const big = () =>
  new Promise((resolve) => {
    const srv = net.createServer((s) => {
      s.on('error', () => {});
      s.write(Buffer.alloc(16 * 1024 * 1024));
      later(() => {
        s.destroy();
        srv.close(() => {
          log('a 16 MiB write, then destroy: server closed');
          resolve();
        });
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
