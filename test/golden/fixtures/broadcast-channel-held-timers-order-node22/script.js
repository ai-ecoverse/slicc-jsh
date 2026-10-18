// Timers that became due while slow port handlers ran run once every queued
// message is delivered, in the order of Node's timers phase, wherever the
// turn's own steps fall among their due times. They are set in the first
// handler, before its busy wait, so the turn has begun before any of them
// is due, and the output doesn't depend on the load.
const busy = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};
const channels = (name, onB, then) => {
  const a = new BroadcastChannel(name);
  const b = new BroadcastChannel(name);
  const c = new BroadcastChannel(name);
  const log = [];
  const done = () => {
    console.log(log.join('\n'));
    a.close();
    b.close();
    c.close();
    then?.();
  };
  b.onmessage = (e) => onB(e.data, log, done);
  c.onmessage = (e) => log.push(`c ${e.data}`);
  return a;
};

// Intervals and timeouts with distinct delays: the order they became due.
const byDelay = () => {
  console.log('-- by delay');
  const a = channels('delays', (m, log, done) => {
    if (m === 'm1') {
      for (let ms = 5; ms <= 55; ms += 5) {
        if (ms % 10) {
          const t = setInterval(() => {
            log.push(`interval ${ms}`);
            clearInterval(t);
          }, ms);
        } else setTimeout(() => log.push(`timeout ${ms}`), ms);
      }
      setTimeout(done, 60);
    }
    busy(17);
    log.push(`b ${m}`);
  }, perList);
  a.postMessage('m1');
  a.postMessage('m2');
  a.postMessage('m3');
};

// Node keeps a list per delay and takes the lists by when their first timer
// is due: a 20 ms timeout set 10 ms before a 15 ms interval takes the other
// 20 ms timeout, due after the interval, ahead of it.
const perList = () => {
  console.log('-- per list');
  const a = channels('lists', (m, log, done) => {
    if (m === 'm1') {
      setTimeout(() => log.push('first 20'), 20);
      busy(10);
      const t = setInterval(() => {
        log.push('interval 15');
        clearInterval(t);
      }, 15);
      setTimeout(() => log.push('second 20'), 20);
      setTimeout(done, 50);
    }
    busy(40);
    log.push(`b ${m}`);
  });
  a.postMessage('m1');
  a.postMessage('m2');
};

byDelay();
