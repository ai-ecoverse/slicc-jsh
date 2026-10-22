const net = require('net');
const until = (cond, then) => (cond() ? setImmediate(() => setImmediate(then)) : setImmediate(() => until(cond, then)));
const atEof = (s, n) => () => s._readableState.ended && s.readableLength === n;
const state = (s, events) => `buffered ${s.readableLength} readableFlowing ${s.readableFlowing} readableEnded ${s.readableEnded} events ${JSON.stringify(events.join(' '))}`;
const watch = (s) => {
  const events = [];
  s.on('end', () => events.push('end'));
  const closed = new Promise((resolve) => s.on('close', () => resolve(events.push('close'))));
  return { events, closed };
};
const readLate = (label, s) =>
  new Promise((resolve) => {
    const { events, closed } = watch(s);
    until(atEof(s, 7), () => {
      console.log(label, 'unread at EOF:', state(s, events));
      let got = '';
      s.on('data', (d) => (got += d));
      closed.then(() => resolve(console.log(label, 'read late:', JSON.stringify(got), 'events', events.join(' '))));
    });
  });
const run = (onServer, onClient) =>
  new Promise((resolve) => {
    const srv = net.createServer((s) => onServer(s));
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      Promise.resolve(onClient(c)).then(() => srv.close(resolve));
    });
  });
(async () => {
  await run((s) => s.end('payload'), (c) => readLate('client', c));
  let served;
  await run(
    (s) => (served = readLate('server', s)),
    (c) => {
      c.on('connect', () => c.end('payload'));
      c.resume();
      return new Promise((resolve) => c.on('close', resolve)).then(() => served);
    }
  );
  await run(
    (s) => s.end('payload'),
    (c) =>
      new Promise((resolve) => {
        const { events, closed } = watch(c);
        until(atEof(c, 7), () => {
          console.log('never read, at EOF:', state(c, events));
          c.destroy();
          closed.then(() => resolve(console.log('never read, destroyed:', state(c, events))));
        });
      })
  );
  console.log('done');
})();
