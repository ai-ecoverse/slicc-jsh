const cp = require('child_process');

const cases = [
  ['exit 143', 'sh', ['-c', 'exit 143']],
  ['exit 130', 'sh', ['-c', 'exit 130']],
  ['exit 137', 'node', ['-e', 'process.exit(137)']],
  ['self SIGKILL', 'node', ['-e', "process.kill(process.pid, 'SIGKILL')"]],
  ['self SIGTERM', 'node', ['-e', "process.kill(process.pid, 'SIGTERM')"]],
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
