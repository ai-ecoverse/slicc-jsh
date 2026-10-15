const { spawn, exec } = require('child_process');
const c = spawn('sleep', ['5']);
c.on('spawn', () => { console.log('spawned'); setTimeout(() => console.log('kill ->', c.kill('SIGTERM')), 100); });
c.on('exit', (code, sig) => {
  console.log('sleep exit', code, sig, 'killed', c.killed, 'signalCode', c.signalCode);
  const d = spawn('sh', ['-c', 'kill -9 $$']);
  d.on('close', (code2, sig2) => {
    console.log('self SIGKILL', code2, sig2);
    exec('sleep 5', { timeout: 200 }, (err) => console.log('exec timeout', err.killed, err.signal, err.code));
  });
});
