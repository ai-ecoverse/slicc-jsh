const cp = require('child_process');
const c = cp.spawn(process.execPath, ['stop.js'], { stdio: ['ignore', 'pipe', 'inherit'] }); let o = ''; c.stdout.on('data', (d) => (o += d));
setTimeout(() => { console.log('signalCode while stopped', c.signalCode, c.exitCode); c.kill('SIGCONT'); }, 1000);
c.on('exit', (code, sig) => console.log('child exit', code, sig, JSON.stringify(o)));
