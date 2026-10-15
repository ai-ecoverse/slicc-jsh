// A timer that is already due when the channels' messages are delivered runs
// first (Node's timers phase comes before the poll phase that delivers them);
// one that becomes due while they are delivered waits for them.
const a = new BroadcastChannel('due');
const b = new BroadcastChannel('due');
const log = [];
const busy = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};
b.onmessage = (e) => {
  log.push(`b ${e.data}`);
  if (e.data === 'm1') {
    setTimeout(() => log.push('late timer'), 5);
    busy(20);
  }
};
a.postMessage('m1');
a.postMessage('m2');
setTimeout(() => log.push('due timer'), 5);
busy(20);
setTimeout(() => {
  console.log(log.join(' | '));
  a.close();
  b.close();
}, 100);
