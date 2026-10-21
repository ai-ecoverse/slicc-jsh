const cp = require('child_process');
for (const sig of ['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGUSR1', 'SIGHUP']) {
  const r = cp.spawnSync(process.execPath, ['selfkill.js', sig, '/tmp/skp-' + sig]);
  console.log('spawnSync', sig, JSON.stringify([r.status, r.signal, String(r.stdout)]));
}
const done = {};
const report = (key, ...line) => {
  done[key] = line;
  if (done.close && done.exec) for (const k of ['close', 'exec']) console.log(...done[k]);
};
const c = cp.spawn(process.execPath, ['selfkill.js', 'SIGTERM', '/tmp/ska']); c.on('close', (code, sig) => report('close', 'async close', code, sig));
cp.exec(`"${process.execPath}" selfkill.js SIGINT /tmp/ske`, (e) => report('exec', 'exec', e && e.code, e && e.signal, e && e.killed));
