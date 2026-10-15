// A handler that takes longer than the pending timers' delays: Node delivers
// every message already queued on the channels' ports before those timers
// run (in their own order), and a timer the handler clears never runs.
const a = new BroadcastChannel('slow');
const b = new BroadcastChannel('slow');
const c = new BroadcastChannel('slow');
const log = [];
const busy = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};
const cleared = setTimeout(() => log.push('cleared timer ran'), 20);
b.onmessage = (e) => {
  busy(40);
  log.push(`b ${e.data}`);
  Promise.resolve().then(() => log.push(`b micro ${e.data}`));
  if (e.data === 'm2') clearTimeout(cleared);
};
c.onmessage = (e) => log.push(`c ${e.data}`);
const tick = setInterval(() => {
  log.push('tick');
  clearInterval(tick);
}, 15);
setTimeout(() => {
  log.push('timer');
  console.log(log.join(' | '));
  a.close();
  b.close();
  c.close();
}, 20);
a.postMessage('m1');
a.postMessage('m2');
