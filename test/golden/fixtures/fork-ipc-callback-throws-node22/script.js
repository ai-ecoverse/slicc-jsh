// A queued send's callback throws (the program handles it as uncaught): the
// channel goes on, and the sends after it are written and called back.
const { fork } = require('child_process');
const path = require('path');
if (process.send) {
  let n = 0;
  process.on('message', () => {
    if (++n === 3) process.disconnect();
  });
  return;
}
const big = 'x'.repeat(1 << 20);
const cp = fork(__filename);
const seen = [];
process.on('uncaughtException', (e) => seen.push(`uncaught ${e.message}`));
cp.on('spawn', () => {
  cp.send(big, () => {
    seen.push('callback 1');
    throw new Error('from callback 1');
  });
  cp.send(big, () => seen.push('callback 2'));
  cp.send(big, () => seen.push('callback 3'));
});
cp.on('close', (code) => console.log([...seen, `close ${code}`].join(' | ')));
