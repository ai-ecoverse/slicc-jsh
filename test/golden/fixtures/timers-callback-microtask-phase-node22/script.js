const fs = require('fs');
const net = require('net');
const busy = () => { const start = Date.now(); while (Date.now() - start < 20) {} };
const both = (out) => {
  setTimeout(() => out.push('timeout 0'), 0);
  setImmediate(() => out.push('immediate'));
  busy();
};
const row = (label, start) => new Promise((done) => {
  const out = [];
  start(out);
  setTimeout(() => { console.log(`${label} | ${out.join(', ')}`); done(); }, 60);
});
(async () => {
  await row("an immediate's promise continuation", (out) => setImmediate(() => Promise.resolve().then(() => both(out))));
  await row("an immediate's third await", (out) => setImmediate(async () => { await null; await null; await null; both(out); }));
  await row("an immediate's queueMicrotask", (out) => setImmediate(() => queueMicrotask(() => both(out))));
  await row("a nextTick from an immediate's promise continuation", (out) => setImmediate(() => Promise.resolve().then(() => process.nextTick(() => both(out)))));
  await row("a promise continuation from an immediate's nextTick", (out) => setImmediate(() => process.nextTick(() => Promise.resolve().then(() => both(out)))));
  await row("a nextTick in a nextTick from an immediate's promise continuation", (out) => setImmediate(() => Promise.resolve().then(() => process.nextTick(() => process.nextTick(() => both(out))))));
  await row("a readFile callback started from an immediate", (out) => setImmediate(() => fs.readFile(__filename, () => both(out))));
  await row("a readFile callback started from an immediate's promise continuation", (out) => setImmediate(() => Promise.resolve().then(() => fs.readFile(__filename, () => both(out)))));
  await row("a stat callback's promise continuation, started from an immediate", (out) => setImmediate(() => fs.stat(__filename, () => Promise.resolve().then(() => both(out)))));
  await row("an exists callback started from an immediate", (out) => setImmediate(() => fs.exists(__filename, () => both(out))));
  await row("an awaited fs.promises.realpath started from an immediate", (out) => setImmediate(async () => { await fs.promises.realpath(__filename); both(out); }));
  await row("an awaited fs.promises.stat started from an immediate", (out) => setImmediate(async () => { await fs.promises.stat(__filename); both(out); }));
  await row("an immediate's promise continuation after it started a stat", (out) => setImmediate(() => { fs.stat(__filename, () => {}); Promise.resolve().then(() => both(out)); }));
  await row("an immediate's queueMicrotask after it started a readFile", (out) => setImmediate(() => { fs.readFile(__filename, () => {}); queueMicrotask(() => both(out)); }));
  await row("an immediate's await after it started an fs.promises.realpath", (out) => setImmediate(async () => { fs.promises.realpath(__filename); await null; await null; both(out); }));
  await row("an immediate's nextTick's promise continuation after it started an exists", (out) => setImmediate(() => { fs.exists(__filename, () => {}); process.nextTick(() => Promise.resolve().then(() => both(out))); }));
  await row("a stat callback started from an immediate that also queued its own promise continuation", (out) => setImmediate(() => { fs.stat(__filename, () => both(out)); Promise.resolve().then(() => {}); }));
  await row("an awaited fs.promises.open started from an immediate", (out) => setImmediate(async () => { const h = await fs.promises.open(__filename); both(out); await h.close(); }));
  const h = await fs.promises.open(__filename);
  await row("an awaited FileHandle read started from an immediate", (out) => setImmediate(async () => { await h.read(Buffer.alloc(4), 0, 4, 0); both(out); }));
  await row("an awaited FileHandle stat started from an immediate", (out) => setImmediate(async () => { await h.stat(); both(out); }));
  await row("an awaited FileHandle readFile started from an immediate", (out) => setImmediate(async () => { await h.readFile(); both(out); }));
  await row("an awaited fs.promises.readFile of a FileHandle started from an immediate", (out) => setImmediate(async () => { await fs.promises.readFile(h); both(out); }));
  await row("an awaited FileHandle close started from an immediate", (out) => setImmediate(async () => { await h.close(); both(out); }));
  await row("a timer's promise continuation", (out) => setTimeout(() => Promise.resolve().then(() => both(out)), 1));
  await row("a timer's third await", (out) => setTimeout(async () => { await null; await null; await null; both(out); }, 1));
  await row("a nextTick from a timer's promise continuation", (out) => setTimeout(() => Promise.resolve().then(() => process.nextTick(() => both(out))), 1));
  await row("a readFile callback's promise continuation", (out) => fs.readFile(__filename, () => Promise.resolve().then(() => both(out))));
  await row("a nextTick from a readFile callback's promise continuation", (out) => fs.readFile(__filename, () => Promise.resolve().then(() => process.nextTick(() => both(out)))));
  await row("a readFile callback's third await", (out) => fs.readFile(__filename, async () => { await null; await null; await null; both(out); }));
  await row("an immediate after a readFile callback's promise continuation", (out) => fs.readFile(__filename, () => Promise.resolve().then(() => setImmediate(() => Promise.resolve().then(() => both(out))))));
  await row("destroy() in an immediate's promise continuation", (out) => {
    const srv = net.createServer((s) => s.once('data', () => setImmediate(() => Promise.resolve().then(() => {
      s.on('close', () => out.push('close'));
      s.destroy();
      both(out);
      srv.close();
    }))));
    srv.listen(0, '127.0.0.1', () => { const c = net.connect(srv.address().port, '127.0.0.1'); c.on('error', () => {}); c.on('connect', () => c.write('x')); });
  });
  console.log('done');
})();
