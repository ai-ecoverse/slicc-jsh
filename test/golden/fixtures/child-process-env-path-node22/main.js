const cp = require('child_process');
for (const [label, opts] of [['PATH=/nonexistent', { env: { PATH: '/nonexistent' } }], ['no PATH', { env: {} }], ['default', {}]]) {
  const r = cp.spawnSync('sh', ['-c', 'echo ran'], { encoding: 'utf8', ...opts });
  console.log(label, r.error ? [r.error.code, r.error.syscall, r.error.path].join(' ') : `${r.status} ${r.stdout.trim()}`);
}
cp.spawn('sh', ['-c', 'echo x'], { env: { PATH: '/nonexistent' } }).on('error', (e) => console.log('async', e.code, e.message));
try {
  cp.execFileSync('sh', ['-c', 'true'], { env: { PATH: '/nonexistent' } });
} catch (e) {
  console.log('execFileSync', e.code, e.syscall);
}
