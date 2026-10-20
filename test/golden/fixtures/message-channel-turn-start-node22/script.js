// A message turn starts when the task that posted ended, not when jsh's own
// task for it got to run (#451): a timeout that becomes due in between, here
// by a long microtask after the posts in a timer callback, still waits for
// the poll phase and the check phase, as in Node, where the poll phase comes
// in the same iteration as the timer that posted.
setTimeout(() => {
  const L = [];
  const { port1, port2 } = new MessageChannel();
  setImmediate(() => L.push('imm'));
  port2.onmessage = (e) => { L.push('mc ' + e.data); setImmediate(() => L.push('imm from handler')); };
  port1.postMessage('x');
  port1.postMessage('y');
  setTimeout(() => L.push('timer 60'), 60);
  queueMicrotask(() => { const t = Date.now(); while (Date.now() - t < 80); });
  setTimeout(() => { console.log(L.join(' | ')); port1.close(); }, 300);
}, 5);
