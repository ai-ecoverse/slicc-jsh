const net = require('net');
const fs = require('fs');
const collect = (label, done, count = 2) => {
  const out = [];
  out.push = (entry) => {
    Array.prototype.push.call(out, entry);
    if (out.length === count) setTimeout(() => { console.log(`${label} | ${out.join(', ')}`); done(); }, 0);
  };
  return out;
};
const both = (label, done) => {
  const out = collect(label, done);
  setTimeout(() => out.push('timeout 0'), 0);
  setImmediate(() => out.push('immediate'));
};
const step = (fn) => new Promise((resolve) => fn(resolve));
(async () => {
  await step((done) => fs.readFile(__filename, () => both('a readFile callback', done)));
  await step((done) => fs.stat(__filename, () => both('a stat callback', done)));
  await step((done) => {
    const srv = net.createServer((s) => s.once('data', () => both('a socket data callback', () => { s.destroy(); srv.close(done); })));
    srv.listen(0, '127.0.0.1', () => { const c = net.connect(srv.address().port, '127.0.0.1'); c.on('error', () => {}); c.on('connect', () => c.write('x')); });
  });
  await step((done) => {
    const srv = net.createServer(() => {});
    srv.listen(0, '127.0.0.1', () => both('a listen callback', () => srv.close(done)));
  });
  await step((done) => setTimeout(() => both('a timer callback', done), 1));
  await step((done) => fs.readFile(__filename, () => {
    const out = collect('immediate first from a readFile callback', done);
    setImmediate(() => out.push('immediate'));
    setTimeout(() => out.push('timeout 0'), 0);
  }));
  await step((done) => {
    const srv = net.createServer((s) => s.once('data', () => {
      const out = collect('destroy() in a data callback', () => srv.close(done), 3);
      s.on('close', () => out.push('close'));
      s.destroy();
      setTimeout(() => out.push('timeout 0'), 0);
      setImmediate(() => out.push('immediate'));
    }));
    srv.listen(0, '127.0.0.1', () => { const c = net.connect(srv.address().port, '127.0.0.1'); c.on('error', () => {}); c.on('connect', () => c.write('x')); });
  });
  console.log('done');
})();
