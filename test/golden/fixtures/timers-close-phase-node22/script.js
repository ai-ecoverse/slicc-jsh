const net = require('net');
const busy = () => { const start = Date.now(); while (Date.now() - start < 20) {} };
const both = (out) => {
  setTimeout(() => out.push('timeout 0'), 0);
  setImmediate(() => out.push('immediate'));
  busy();
};
const pair = (onSocket) => new Promise((done) => {
  const srv = net.createServer((s) => s.once('data', () => onSocket(s, () => srv.close(done))));
  srv.listen(0, '127.0.0.1', () => { const c = net.connect(srv.address().port, '127.0.0.1'); c.on('error', () => {}); c.on('connect', () => c.write('x')); });
});
const row = (label, start) => pair((s, done) => {
  const out = [];
  start(s, out);
  setTimeout(() => { console.log(`${label} | ${out.join(', ')}`); done(); }, 100);
});
(async () => {
  await row("a socket's close handler, destroyed in its data callback", (s, out) => { s.on('close', () => both(out)); s.destroy(); });
  await row("a socket's close handler's promise continuation, closed after the pending immediate", (s, out) => { s.on('close', () => Promise.resolve().then(() => both(out))); s.destroy(); setImmediate(() => out.push('pending immediate')); });
  await row("a socket's close handler's nextTick, closed after the pending immediate", (s, out) => { s.on('close', () => process.nextTick(() => both(out))); s.destroy(); setImmediate(() => out.push('pending immediate')); });
  await row("a socket's close handler, closed after the pending immediate", (s, out) => { s.on('close', () => both(out)); s.destroy(); setImmediate(() => out.push('pending immediate')); });
  await row("a socket's close handler, destroyed in an immediate", (s, out) => { s.on('close', () => both(out)); setImmediate(() => s.destroy()); });
  await row("a socket's close handler, destroyed in a timer", (s, out) => { s.on('close', () => both(out)); setTimeout(() => s.destroy(), 1); });
  console.log('done');
})();
