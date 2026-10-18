// A handler that takes longer than the pending timers' delays: Node delivers
// every message already queued on the channels' ports before those timers
// run (in their own order), and a timer the handler clears never runs. The
// first handler sets the timers before it busy-waits, so they are due, in
// the order of their delays, before it returns, and the messages are queued
// before any of them is due. The interval is set first: Node takes its
// timer lists (one per delay) by when their first timer is due, so a 20 ms
// one set before it would take the 20 ms list, and the other 20 ms timer,
// ahead of it if the program stalled 5 ms in between.
const a = new BroadcastChannel('slow');
const b = new BroadcastChannel('slow');
const c = new BroadcastChannel('slow');
const log = [];
const busy = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};
let cleared;
const arm = () => {
  const tick = setInterval(() => {
    log.push('tick');
    clearInterval(tick);
  }, 15);
  cleared = setTimeout(() => log.push('cleared timer ran'), 20);
  setTimeout(() => {
    log.push('timer');
    console.log(log.join(' | '));
    a.close();
    b.close();
    c.close();
  }, 20);
};
b.onmessage = (e) => {
  if (e.data === 'm1') arm();
  busy(40);
  log.push(`b ${e.data}`);
  Promise.resolve().then(() => log.push(`b micro ${e.data}`));
  if (e.data === 'm2') clearTimeout(cleared);
};
c.onmessage = (e) => log.push(`c ${e.data}`);
a.postMessage('m1');
a.postMessage('m2');
