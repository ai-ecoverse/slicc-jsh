const L = [];
const { port1, port2 } = new MessageChannel();
port2.onmessage = (e) => { L.push('mc ' + e.data); setImmediate(() => L.push('imm from ' + e.data)); };
setImmediate(() => L.push('imm'));
setTimeout(() => L.push('timer 60'), 60);
queueMicrotask(() => {
  port1.postMessage('x');
  port1.postMessage('y');
  (async () => {
    await null;
    await null;
    const t = Date.now();
    while (Date.now() - t < 80);
  })();
});
setTimeout(() => { console.log(L.join(' | ')); port1.close(); }, 300);
