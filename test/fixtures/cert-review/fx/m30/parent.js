const cp = require('child_process');
const fs = require('fs');
const c = cp.spawn(process.execPath, ['stop.js'], { stdio: ['ignore', 'pipe', 'inherit'] }); let o = '';
const stopped = () => { try { return /^State:\s+T/m.test(fs.readFileSync(`/proc/${c.pid}/status`, 'utf8')); } catch { return null; } };
let sent = false;
const cont = () => { if (sent) return; sent = true; console.log('signalCode while stopped', c.signalCode, c.exitCode); c.kill('SIGCONT'); };
const waitStopped = (left) => { const s = stopped(); if (s === null) return setTimeout(cont, 200); if (s || left <= 0) return cont(); setTimeout(() => waitStopped(left - 1), 20); };
c.stdout.on('data', (d) => { o += d; if (!sent && o.includes('before stop')) waitStopped(500); });
c.on('exit', (code, sig) => console.log('child exit', code, sig, JSON.stringify(o)));
