const net = require('net');
const busy = () => { const start = Date.now(); while (Date.now() - start < 20) {} };
const immediateFirst = (out) => {
  setImmediate(() => out.push('immediate'));
  setTimeout(() => out.push('timeout 0'), 0);
  busy();
};
const pair = (onSocket) => new Promise((done) => {
  const srv = net.createServer((s) => s.once('data', () => onSocket(s, () => srv.close(done))));
  srv.listen(0, '127.0.0.1', () => { const c = net.connect(srv.address().port, '127.0.0.1'); c.on('error', () => {}); c.on('connect', () => c.write('x')); });
});
const row = (label, start, count = 2) => pair((s, done) => {
  const out = [];
  out.push = (entry) => {
    Array.prototype.push.call(out, entry);
    if (out.length === count) setTimeout(() => { console.log(`${label} | ${out.join(', ')}`); done(); }, 0);
  };
  start(s, out);
});
(async () => {
  await row("a close handler's immediate, then its setTimeout 0, destroyed in a data callback", (s, out) => { s.on('close', () => immediateFirst(out)); s.destroy(); });
  await row("a close handler's promise continuation's immediate, then its setTimeout 0", (s, out) => { s.on('close', () => Promise.resolve().then(() => immediateFirst(out))); s.destroy(); });
  await row("a close handler's immediate, then its setTimeout 0, closed after the pending immediate", (s, out) => { s.on('close', () => immediateFirst(out)); s.destroy(); setImmediate(() => out.push('pending immediate')); }, 3);
  await row("a close handler's immediate, then its setTimeout 0, destroyed in an immediate", (s, out) => { s.on('close', () => immediateFirst(out)); setImmediate(() => s.destroy()); });
  await row("a close handler's immediate, then its setTimeout 0, destroyed in a timer", (s, out) => { s.on('close', () => immediateFirst(out)); setTimeout(() => s.destroy(), 1); });
  console.log('done');
})();
