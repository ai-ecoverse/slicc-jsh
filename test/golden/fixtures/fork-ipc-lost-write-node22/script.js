// A queued send that the child never reads: Node's oncomplete for an async
// channel write takes no status (lib/internal/child_process.js), so the
// send's callback gets null and no 'error' comes, though the child exited
// without reading it. The parent queues 4 MiB, more than a socket holds,
// then tells the child to exit; the child waits for that on a file.
const fs = require('fs');
const path = require('path');
const flag = path.join(__dirname, 'flag');
if (process.send) {
  while (!fs.existsSync(flag)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  process.reallyExit(0);
}
try {
  fs.unlinkSync(flag);
} catch {}
const { fork } = require('child_process');
const cp = fork(__filename);
const seen = [];
cp.on('error', (e) => seen.push(`error ${e.code}`));
cp.on('disconnect', () => seen.push('disconnect'));
cp.on('spawn', () => {
  const ok = cp.send({ big: 'x'.repeat(4 << 20) }, (err) => seen.push(`callback ${err ? err.code : null}`));
  seen.push(`send ${ok}`);
  fs.writeFileSync(flag, '');
});
cp.on('close', (code) => {
  seen.push(`close ${code}`);
  setImmediate(() => {
    console.log(seen.join(' | '));
    fs.unlinkSync(flag);
  });
});
