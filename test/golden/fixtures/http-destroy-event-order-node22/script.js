const http = require('http');
const net = require('net');

const upload = (label, handler, { bytes = 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nx', clientError = true } = {}) =>
  new Promise((resolve) => {
    const ev = [];
    const srv = http.createServer((req, res) => {
      req.on('aborted', () => ev.push('aborted'));
      req.on('error', (e) => ev.push(`req error ${e.message}`));
      req.on('close', () => ev.push('req close'));
      res.on('close', () => ev.push('res close'));
      req.socket.on('error', (e) => ev.push(`socket error ${e.message}`));
      req.socket.on('close', () => ev.push('socket close'));
      handler(req, res, ev);
    });
    if (clientError) srv.on('clientError', (e) => ev.push(`clientError ${e.message}`));
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      let got = '';
      c.on('connect', () => c.write(bytes));
      c.on('data', (d) => (got += d));
      c.on('error', () => {});
      c.on('close', () =>
        setImmediate(() => {
          console.log(`${label} | ${ev.join(', ')} | ${got.split('\r\n')[0] || '-'}`);
          srv.close(resolve);
        })
      );
    });
  });

const socket = (label, kill) =>
  new Promise((resolve) => {
    const srv = net.createServer((s) => {
      const ev = [];
      s.on('error', () => {
        ev.push('error');
        process.nextTick(() => ev.push('tick from error'));
        process.nextTick(() => process.nextTick(() => ev.push('tick in a tick from error')));
        Promise.resolve().then(() => ev.push('microtask from error'));
      });
      s.on('close', () => {
        ev.push('close');
        setImmediate(() => {
          console.log(`${label} | ${ev.join(', ')}`);
          srv.close(resolve);
        });
      });
      s.once('data', () => {
        kill(s);
        ev.push('sync');
        process.nextTick(() => ev.push('tick'));
        Promise.resolve().then(() => {
          ev.push('microtask');
          process.nextTick(() => ev.push('tick from a microtask'));
        });
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      c.on('error', () => {});
      c.on('connect', () => c.write('x'));
    });
  });

(async () => {
  await upload('req.destroy(err) during an upload', (req) => req.destroy(new Error('boom')));
  await upload('req.destroy(err) with the body complete and unread', (req) => req.destroy(new Error('boom')), { bytes: 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\n\r\nx' });
  await upload('req.destroy(err) on a GET', (req) => req.destroy(new Error('boom')), { bytes: 'GET / HTTP/1.1\r\nHost: x\r\n\r\n' });
  await upload('req.destroy() during an upload', (req) => req.destroy());
  await upload('req.destroy(err) after some of the body', (req) => req.once('data', () => req.destroy(new Error('boom'))));
  await upload('req.destroy(err) without an error listener', (req) => {
    req.removeAllListeners('error');
    req.destroy(new Error('boom'));
  });
  await upload('req.destroy(err) without a clientError listener', (req) => req.destroy(new Error('boom')), { clientError: false });
  await socket('a net socket: destroy()', (s) => s.destroy());
  await socket('a net socket: destroy(err)', (s) => s.destroy(new Error('x')));
  await socket('a net socket: write, then destroy()', (s) => {
    s.write('y');
    s.destroy();
  });
  console.log('done');
})();
