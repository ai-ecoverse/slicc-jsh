const net = require('net');
const round = (mode) =>
  new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('end', () => console.log(mode, 'server end'));
      sock.on('close', () => {
        console.log(mode, 'server close');
        server.close(() => {
          console.log(mode, 'server closed');
          resolve();
        });
      });
      sock.resume();
    });
    server.listen(0, '127.0.0.1', () => {
      const s = net.connect(server.address().port, '127.0.0.1', () => {
        console.log(mode, 'connect');
        const own = s._destroy;
        s._destroy = function (err, cb) {
          console.log(mode, '_destroy');
          if (mode === 'as is') return own.call(this, err, cb);
          own.call(this, err, (e) => {
            console.log(mode, 'callback');
            if (mode === 'unref') setTimeout(() => cb(e), 60000).unref();
          });
        };
        s.on('close', (hadError) => console.log(mode, 'client close', hadError, s.destroyed));
        s.destroy();
      });
    });
  });
process.on('exit', (code) => console.log('exit', code));
(async () => {
  for (const mode of ['as is', 'swallowed', 'unref']) await round(mode);
})();
