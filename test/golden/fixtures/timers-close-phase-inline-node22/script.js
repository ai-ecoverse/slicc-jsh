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
const row = (label, start, count = 2) => pair((s, done) => {
  const out = [];
  out.push = (entry) => {
    Array.prototype.push.call(out, entry);
    if (out.length === count) setTimeout(() => { console.log(`${label} | ${out.join(', ')}`); done(); }, 0);
  };
  start(s, out);
});
(async () => {
  await row("a close handler's promise continuation", (s, out) => { s.on('close', () => Promise.resolve().then(() => both(out))); s.destroy(); });
  await row("a close handler's nextTick", (s, out) => { s.on('close', () => process.nextTick(() => both(out))); s.destroy(); });
  await row("a close handler's third await", (s, out) => { s.on('close', async () => { await null; await null; await null; both(out); }); s.destroy(); });
  await row("a close handler's queueMicrotask, destroyed in an immediate", (s, out) => { s.on('close', () => queueMicrotask(() => both(out))); setImmediate(() => s.destroy()); });
  await row("a close handler's promise continuation, destroyed in a timer", (s, out) => { s.on('close', () => Promise.resolve().then(() => both(out))); setTimeout(() => s.destroy(), 1); });
  await row("a data callback's nextTick and promise job, then the close", (s, out) => { s.on('close', () => out.push('close')); s.destroy(); process.nextTick(() => out.push('tick')); Promise.resolve().then(() => out.push('promise job')); }, 3);
  console.log('done');
})();
