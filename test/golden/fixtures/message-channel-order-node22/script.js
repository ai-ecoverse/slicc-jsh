// BroadcastChannel and MessageChannel messages, immediates, ticks and timers in
// Node 22's order (#215): each port, in the order the ports were made, takes
// its messages in the poll phase (one per task, a handler's ticks and
// microtasks first), before the immediates (check phase), after a timer that
// was already due; a port the turn has yet to reach takes a message posted
// during it, one it has passed takes it on the next turn. A port with a
// 'message' listener keeps the program alive until it's closed.
const run = (name, setup) => new Promise((resolve) => {
  const L = [];
  const done = setup(L);
  setTimeout(() => { done(); console.log(name + ':', L.join(' | ')); resolve(); }, 60);
});
(async () => {
  await run('bc first', (L) => { const a = new BroadcastChannel('o'), b = new BroadcastChannel('o'); const { port1, port2 } = new MessageChannel(); b.onmessage = (e) => L.push('bc ' + e.data); port2.onmessage = (e) => L.push('mc ' + e.data); a.postMessage(1); port1.postMessage('x'); a.postMessage(2); return () => { a.close(); b.close(); port1.close(); }; });
  await run('mc first', (L) => { const { port1, port2 } = new MessageChannel(); const a = new BroadcastChannel('o'), b = new BroadcastChannel('o'); b.onmessage = (e) => L.push('bc ' + e.data); port2.onmessage = (e) => L.push('mc ' + e.data); a.postMessage(1); port1.postMessage('x'); a.postMessage(2); port1.postMessage('y'); return () => { a.close(); b.close(); port1.close(); }; });
  await run('immediate between', (L) => { const a = new BroadcastChannel('o'), b = new BroadcastChannel('o'); const { port1, port2 } = new MessageChannel(); b.onmessage = (e) => L.push('bc ' + e.data); port2.onmessage = (e) => { L.push('mc ' + e.data); queueMicrotask(() => L.push('mc micro')); process.nextTick(() => L.push('mc tick')); }; port1.postMessage('x'); a.postMessage(1); setImmediate(() => L.push('imm')); a.postMessage(2); return () => { a.close(); b.close(); port1.close(); }; });
  await run('immediate first', (L) => { const { port1, port2 } = new MessageChannel(); setImmediate(() => L.push('imm')); port2.onmessage = (e) => { L.push('mc ' + e.data); setImmediate(() => L.push('imm from handler')); }; port1.postMessage('x'); port1.postMessage('y'); return () => port1.close(); });
  await run('post from an immediate', (L) => { const { port1, port2 } = new MessageChannel(); port2.onmessage = (e) => L.push('mc ' + e.data); setImmediate(() => { L.push('imm 1'); port1.postMessage('x'); }); setImmediate(() => L.push('imm 2')); return () => port1.close(); });
  await run('ping-pong', (L) => { const { port1, port2 } = new MessageChannel(); let n = 0; port2.onmessage = (e) => { L.push('p2 ' + e.data); if (n++ < 2) port2.postMessage('pong'); }; port1.onmessage = (e) => { L.push('p1 ' + e.data); setImmediate(() => L.push('imm')); port1.postMessage('ping'); }; port1.postMessage('ping'); return () => port1.close(); });
  await run('timer vs port', (L) => { const { port1, port2 } = new MessageChannel(); port2.onmessage = (e) => L.push('mc ' + e.data); setTimeout(() => L.push('t0'), 0); port1.postMessage('x'); return () => port1.close(); });
  const { port1, port2 } = new MessageChannel();
  port2.on('message', (m) => { console.log('kept alive, got', m); port2.close(); });
  setTimeout(() => port1.postMessage('late'), 100);
})();
