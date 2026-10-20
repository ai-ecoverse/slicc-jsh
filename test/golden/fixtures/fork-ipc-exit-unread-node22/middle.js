const { spawn } = require('child_process');
const reader = spawn('sh', ['-c', 'while read line; do :; done; echo reader saw end of input'], {
  stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
});
reader.on('spawn', () => {
  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 64; i++) reader.send(chunk);
  console.log('middle queued 4 MiB and exits');
  process.exit(0);
});
