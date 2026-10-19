// Both ends of a fork send about 1 MiB in a synchronous loop before either
// reads: more than a socket holds, so each end's sends must queue what the
// socket doesn't take (libuv's try-write) rather than wait for the other end
// to read. In 'json' and 'advanced', every message arrives once, in order.
const { fork } = require('child_process');
const path = require('path');
const N = 4000;
const PAD = 'x'.repeat(240);

const run = (serialization) =>
  new Promise((resolve) => {
    const cp = fork(path.join(__dirname, 'child.js'), [String(N)], { serialization });
    let next = 0;
    let wrong = 0;
    cp.on('message', (m) => {
      if (m.i !== next || m.pad !== PAD) wrong++;
      next++;
    });
    let sent = 0;
    for (let i = 0; i < N; i++) cp.send({ i, pad: PAD }, (err) => err || sent++);
    console.log(serialization, 'sent', N, 'without waiting on the child');
    cp.on('close', (code, signal) => {
      console.log(serialization, 'parent got', next, 'out of order', wrong, 'callbacks', sent, 'close', code, signal);
      resolve();
    });
  });

(async () => {
  await run('json');
  await run('advanced');
})();
