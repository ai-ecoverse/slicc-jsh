const net = require('net');
const until = (cond, then) => (cond() ? setImmediate(() => setImmediate(then)) : setImmediate(() => until(cond, then)));
const atEof = (s, n) => () => s._readableState.ended && s.readableLength === n;
const watch = (s, names) => {
  const events = [];
  for (const e of names) s.on(e, () => events.push(e));
  const closed = new Promise((resolve) => s.on('close', () => resolve(events.push('close'))));
  return { events, closed };
};
const self = (s) => watch(s, ['end', 'finish']);
const peer = (s) => watch(s, ['end']);
const state = (s, mine, theirs) =>
  `buffered ${s.readableLength} readableFlowing ${s.readableFlowing} readableEnded ${s.readableEnded} writableEnded ${s.writableEnded} events ${JSON.stringify(mine.events.join(' '))} peer ${JSON.stringify(theirs.events.join(' '))}`;
const readLate = (label, s, other) =>
  new Promise((resolve) => {
    const mine = self(s);
    until(atEof(s, 7), () => {
      console.log(label, 'unread at EOF:', state(s, mine, other()));
      let got = '';
      s.on('data', (d) => (got += d));
      Promise.all([mine.closed, other().closed]).then(() =>
        resolve(console.log(label, 'read late:', JSON.stringify(got), 'events', mine.events.join(' '), 'peer', other().events.join(' ')))
      );
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
  let server;
  await run(
    (s) => {
      server = peer(s);
      s.resume();
      s.end('payload');
    },
    (c) => readLate('client', c, () => server)
  );
  let client;
  let served;
  await run(
    (s) => (served = readLate('server', s, () => client)),
    (c) => {
      client = peer(c);
      c.on('connect', () => c.end('payload'));
      c.resume();
      return client.closed.then(() => served);
    }
  );
  await run(
    (s) => {
      server = peer(s);
      s.resume();
      s.end('payload');
    },
    (c) =>
      new Promise((resolve) => {
        const mine = self(c);
        until(atEof(c, 7), () => {
          console.log('never read, at EOF:', state(c, mine, server));
          c.destroy();
          Promise.all([mine.closed, server.closed]).then(() => resolve(console.log('never read, destroyed:', state(c, mine, server))));
        });
      })
  );
  const srv = net.createServer((s) => s.end('payload', () => s.destroy()));
  srv.listen(0, '127.0.0.1', () => {
    srv.unref();
    const c = net.connect(srv.address().port, '127.0.0.1');
    const mine = self(c);
    process.on('exit', () => console.log('never read, at exit:', `buffered ${c.readableLength} readableEnded ${c.readableEnded} writableEnded ${c.writableEnded} events ${JSON.stringify(mine.events.join(' '))}`));
  });
})();
