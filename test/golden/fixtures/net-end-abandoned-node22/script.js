const net = require('net');
(async () => {
  const code = (e) => (e ? e.code ?? e.message : 'null');
  const abandoned = (label, data, connect, then) =>
    new Promise((resolve) => {
      const r = { cb: 'none', error: 'none', finish: false };
      const s = connect();
      s.on('error', (e) => (r.error = code(e)));
      s.on('finish', () => (r.finish = true));
      s.on('close', () =>
        setImmediate(() =>
          resolve(console.log(label, data ? 'end(data)' : 'end()', `| end cb ${r.cb} | error ${r.error} | finish ${r.finish} | writableFinished ${s.writableFinished}`))
        )
      );
      const cb = (e) => (r.cb = code(e));
      if (data) s.end('payload', cb);
      else s.end(cb);
      then?.(s);
    });
  const srv = net.createServer((s) => s.resume());
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  const dead = net.createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => dead.once('listening', resolve));
  const deadPort = dead.address().port;
  await new Promise((resolve) => dead.close(resolve));
  for (const data of [false, true]) {
    await abandoned('refused', data, () => net.connect(deadPort, '127.0.0.1'));
    await abandoned('destroy() while connecting', data, () => net.connect(port, '127.0.0.1'), (s) => s.destroy());
    await abandoned('destroy(err) while connecting', data, () => net.connect(port, '127.0.0.1'), (s) => s.destroy(new Error('boom')));
    await abandoned('destroy() in connect', data, () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => s.destroy());
      return s;
    });
  }
  srv.close();
})();
