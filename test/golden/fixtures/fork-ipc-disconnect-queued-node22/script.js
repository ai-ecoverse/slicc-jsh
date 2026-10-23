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
    cp.on('spawn', () => {
      const ok = cp.send({ body: 'x'.repeat(size) }, (err) => seen.push(`callback ${err ? err.code : null}`));
      cp.send('after it');
      cp.disconnect();
      seen.push(`send ${ok}`, `connected ${cp.connected}`);
    });
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
