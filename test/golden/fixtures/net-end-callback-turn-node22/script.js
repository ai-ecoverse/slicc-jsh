const net = require('net');

const srv = net.createServer((s) => {
  s.resume();
  s.on('end', () => s.end());
});

const row = (label, before, act) =>
  new Promise((resolve) => {
    const c = net.connect(srv.address().port, '127.0.0.1', () => {
      const log = [];
      before(c, () => {
        act(c, log);
        process.nextTick(() => log.push('tick'));
        setImmediate(() => log.push('immediate'));
      });
      c.on('close', () =>
        setImmediate(() => {
          console.log(`${label} | ${log.join(', ')}`);
          resolve();
        })
      );
    });
  });

const nothing = (c, then) => then();
const written = (c, then) => c.write('x', then);

srv.listen(0, '127.0.0.1', async () => {
  await row('end(cb) with nothing written', nothing, (c, log) => c.end(() => log.push('end callback')));
  await row("end() and 'finish'", nothing, (c, log) => {
    c.on('finish', () => log.push('finish'));
    c.end();
  });
  await row('end(cb) after a write that called back', written, (c, log) => c.end(() => log.push('end callback')));
  await row("end(cb) and 'finish' after a write that called back", written, (c, log) => {
    c.on('finish', () => log.push('finish'));
    c.end(() => log.push('end callback'));
  });
  srv.close(() => console.log('done'));
});
