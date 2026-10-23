const net = require('net');
const server = net.createServer(() => {});
const run = (label, before, destroyLater, err) => new Promise((resolve) => {
  const c = net.connect(server.address().port, '127.0.0.1');
  const close = () => { console.log(label, 'close'); };
  if (before) c.on('close', close);
  c.on('error', (e) => console.log(label, 'error', e.code ?? e.message));
  c.end('x', (e) => console.log(label, 'end callback', e ? e.code ?? e.message : null));
  if (!before) c.on('close', close);
  c.on('close', () => setImmediate(resolve));
  const destroy = () => (err ? c.destroy(new Error('boom')) : c.destroy());
  if (destroyLater) queueMicrotask(destroy); else destroy();
});
server.listen(0, '127.0.0.1', async () => {
  for (const before of [true, false]) for (const later of [false, true]) for (const err of [false, true]) await run(`close listener ${before ? 'before' : 'after'}, destroy ${later ? 'in a microtask' : 'now'}${err ? ' with an error' : ''}`, before, later, err);
  const bare = net.connect(server.address().port, '127.0.0.1');
  bare.on('close', () => console.log('bare end close'));
  bare.end((e) => console.log('bare end callback', e ? e.code : null));
  bare.destroy();
  await new Promise((resolve) => bare.on('close', () => setImmediate(resolve)));
  await new Promise((resolve) => {
    const got = [];
    const peer = net.createServer((s) => {
      s.on('data', (d) => got.push(String(d)));
      s.on('end', () => {
        console.log('written while connecting, then connected | peer got', JSON.stringify(got.join('')));
        peer.close(resolve);
      });
    });
    peer.listen(0, '127.0.0.1', () => {
      const c = net.connect(peer.address().port, '127.0.0.1');
      console.log('write while connecting returns', c.write('a', (e) => console.log('first write callback', e ? e.code : null)), 'connecting', c.connecting);
      c.write('b');
      c.end('c', (e) => console.log('end callback', e ? e.code : null));
    });
  });
  server.close();
});
