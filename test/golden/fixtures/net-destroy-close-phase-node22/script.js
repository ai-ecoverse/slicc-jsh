const net = require('net');

const row = (label, kill) =>
  new Promise((resolve) => {
    const srv = net.createServer((s) => {
      const ev = [];
      const log = (e) => () => ev.push(e);
      s.on('error', () => {
        ev.push('error');
        process.nextTick(log('tick from error'));
        Promise.resolve().then(log('microtask from error'));
      });
      s.on('close', () => {
        ev.push('close');
        setTimeout(() => {
          console.log(`${label} | ${ev.join(', ')}`);
          srv.close(resolve);
        }, 10);
      });
      s.once('data', () => kill(s, ev, log));
    });
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      c.on('error', () => {});
      c.on('connect', () => c.write('x'));
    });
  });

const after = (ev, log) => {
  ev.push('sync');
  process.nextTick(log('tick'));
  Promise.resolve().then(log('microtask'));
  setImmediate(log('immediate'));
  setTimeout(log('timeout 0'), 0);
};

(async () => {
  await row('destroy()', (s, ev, log) => {
    s.destroy();
    after(ev, log);
  });
  await row('destroy(err)', (s, ev, log) => {
    s.destroy(new Error('x'));
    after(ev, log);
  });
  await row('write, then destroy()', (s, ev, log) => {
    s.write('y');
    s.destroy();
    after(ev, log);
  });
  await row('an immediate queued before destroy()', (s, ev, log) => {
    setImmediate(log('immediate before'));
    s.destroy();
    ev.push('sync');
  });
  await row('two immediates after destroy()', (s, ev, log) => {
    s.destroy();
    ev.push('sync');
    setImmediate(log('first immediate'));
    setImmediate(log('second immediate'));
  });
  await row('an immediate from an immediate', (s, ev, log) => {
    s.destroy();
    ev.push('sync');
    setImmediate(() => {
      ev.push('immediate');
      setImmediate(log('immediate from an immediate'));
    });
  });
  await row('an immediate cleared again', (s, ev, log) => {
    s.destroy();
    ev.push('sync');
    const i = setImmediate(log('cleared immediate'));
    process.nextTick(() => clearImmediate(i));
    setTimeout(log('timeout 0'), 0);
  });
  await row('destroy() inside an immediate', (s, ev, log) => {
    setImmediate(() => {
      s.destroy();
      ev.push('destroyed in an immediate');
      setImmediate(log('immediate after'));
    });
  });
  await row('a tick and a microtask from the last immediate', (s, ev, log) => {
    s.destroy();
    setImmediate(() => {
      ev.push('immediate');
      process.nextTick(log('tick'));
      queueMicrotask(log('microtask'));
    });
  });
  await row('microtasks and ticks queued by microtasks of the last immediate', (s, ev, log) => {
    s.destroy();
    setImmediate(() => {
      ev.push('immediate');
      queueMicrotask(() => {
        ev.push('microtask');
        queueMicrotask(log('microtask from a microtask'));
        process.nextTick(log('tick from a microtask'));
      });
      Promise.resolve().then(log('then')).then(log('then then'));
    });
  });
  await row('an immediate the last immediate queues, with a microtask', (s, ev, log) => {
    s.destroy();
    setImmediate(() => {
      ev.push('immediate');
      queueMicrotask(log('microtask'));
      setImmediate(log('next immediate'));
    });
  });
  console.log('done');
})();
