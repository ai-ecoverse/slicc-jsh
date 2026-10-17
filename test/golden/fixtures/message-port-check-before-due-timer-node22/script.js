// The check phase (immediates) comes before the next timers phase, however
// long the poll phase that delivered the port messages took (#353): a 60 ms
// timer that became due while a handler busied itself still runs after the
// immediates queued by the end of that poll phase, as in Node 22.
const spin = (ms) => { const t = Date.now(); while (Date.now() - t < ms); };
const run = (name, setup) => new Promise((resolve) => {
  const L = [];
  const done = setup(L);
  setTimeout(() => { done(); console.log(name + ':', L.join(' | ')); resolve(); }, 60);
});
(async () => {
  await run('slow handler', (L) => { const { port1, port2 } = new MessageChannel(); setImmediate(() => L.push('imm')); port2.onmessage = (e) => { L.push('mc ' + e.data); spin(40); setImmediate(() => L.push('imm from handler')); }; port1.postMessage('x'); port1.postMessage('y'); return () => port1.close(); });
  await run('slow handler, immediate chain', (L) => { const { port1, port2 } = new MessageChannel(); port2.onmessage = (e) => { L.push('mc ' + e.data); spin(80); setImmediate(() => { L.push('imm'); setImmediate(() => L.push('imm next')); }); }; port1.postMessage('x'); return () => port1.close(); });
  await run('slow start', (L) => { const { port1, port2 } = new MessageChannel(); setImmediate(() => L.push('imm')); port2.onmessage = (e) => { L.push('mc ' + e.data); setImmediate(() => L.push('imm from handler')); }; port1.postMessage('x'); port1.postMessage('y'); spin(80); return () => port1.close(); });
})();
