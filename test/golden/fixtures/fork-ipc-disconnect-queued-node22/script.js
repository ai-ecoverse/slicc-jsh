const { fork } = require('child_process');
if (process.send) {
  const got = [];
  process.on('message', (m) => got.push(m));
  process.on('disconnect', () => {
    process.exitCode = got.length;
  });
  return;
}
const run = (label, size) =>
  new Promise((resolve) => {
    const cp = fork(__filename);
    const seen = [];
    cp.on('error', (e) => seen.push(`error ${e.code}`));
    cp.on('spawn', () => setTimeout(() => {
      const ok = cp.send({ body: 'x'.repeat(size) }, (err) => seen.push(`callback ${err ? err.code : null}`));
      cp.send('after it', (err) => seen.push(`second callback ${err ? err.code : null}`));
      cp.disconnect();
      seen.push(`send ${ok}`, `connected ${cp.connected}`);
      process.nextTick(() => seen.push('tick'));
      Promise.resolve().then(() => seen.push('microtask'));
      setImmediate(() => seen.push('immediate'));
      setTimeout(() => seen.push('timeout'), 0);
    }, 1));
    cp.on('exit', (code) => {
      setImmediate(() => {
        console.log(`${label} | ${seen.join(' | ')} | the child got ${code}`);
        resolve();
      });
    });
  });
(async () => {
  await run('a small send, then disconnect', 10);
  await run('a 4 MiB send still queued, then disconnect', 4 << 20);
})();
