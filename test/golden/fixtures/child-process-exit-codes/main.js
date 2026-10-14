const cp = require('child_process');

const cases = [
  ['exit 143', 'sh', ['-c', 'exit 143']],
  ['exit 130', 'sh', ['-c', 'exit 130']],
  ['exit 137', 'node', ['-e', 'process.exit(137)']],
  ['self SIGKILL', 'node', ['-e', "process.kill(process.pid, 'SIGKILL')"]],
  ['self SIGTERM', 'node', ['-e', "process.kill(process.pid, 'SIGTERM')"]],
  // A shell that signals itself (slicc-kernel 1.73.2 with wasm-bash 5.3.0-18,
  // ai-ecoverse/slicc-kernel#422), and one whose child does.
  ['sh kill -9 $$', 'sh', ['-c', 'kill -9 $$']],
  ['sh kill -TERM $$', 'sh', ['-c', 'kill -TERM $$']],
  ['sh child killed', 'sh', ['-c', "node -e \"process.kill(process.pid, 'SIGKILL')\""]],
];

for (const [label, file, args] of cases) {
  const r = cp.spawnSync(file, args);
  console.log('sync', label, r.status, r.signal);
}

(async () => {
  for (const [label, file, args] of cases) {
    await new Promise((resolve) => {
      const c = cp.spawn(file, args, { stdio: 'ignore' });
      c.on('exit', (code, sig) => {
        console.log('async exit', label, code, sig, c.exitCode, c.signalCode);
      });
      c.on('close', resolve);
    });
  }
  await new Promise((resolve) => {
    cp.exec('exit 143', (err) => {
      console.log('exec exit 143', err.code, err.signal, err.killed);
      resolve();
    });
  });
  await new Promise((resolve) => {
    const k = cp.spawn('node', ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    k.on('spawn', () => k.kill('SIGTERM'));
    k.on('exit', (code, sig) => {
      console.log('kill()', code, sig, k.killed);
      resolve();
    });
  });
})();
