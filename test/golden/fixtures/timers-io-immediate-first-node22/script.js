const net = require('net');
const fs = require('fs');
const both = (label, done) => {
  const out = [];
  setTimeout(() => out.push('timeout 0'), 0);
  setImmediate(() => out.push('immediate'));
  setTimeout(() => { console.log(`${label} | ${out.join(', ')}`); done(); }, 20);
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
    const out = [];
    setImmediate(() => out.push('immediate'));
    setTimeout(() => out.push('timeout 0'), 0);
    setTimeout(() => { console.log(`immediate first from a readFile callback | ${out.join(', ')}`); done(); }, 20);
  }));
  await step((done) => {
    const srv = net.createServer((s) => s.once('data', () => {
      const out = [];
      s.on('close', () => out.push('close'));
      s.destroy();
      setTimeout(() => out.push('timeout 0'), 0);
      setImmediate(() => out.push('immediate'));
      setTimeout(() => { console.log(`destroy() in a data callback | ${out.join(', ')}`); srv.close(done); }, 20);
    }));
    srv.listen(0, '127.0.0.1', () => { const c = net.connect(srv.address().port, '127.0.0.1'); c.on('error', () => {}); c.on('connect', () => c.write('x')); });
  });
  console.log('done');
})();
