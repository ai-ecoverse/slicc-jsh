const cp = require('child_process');
const fs = require('fs');
const c = cp.spawn(process.execPath, ['stop.js'], { stdio: ['ignore', 'pipe', 'inherit'] }); let o = '';
const stopped = () => { try { return /^State:\s+T/m.test(fs.readFileSync(`/proc/${c.pid}/status`, 'utf8')); } catch { return null; } };
let started = false;
let timer;
const cont = () => {
  console.log('signalCode while stopped', c.signalCode, c.exitCode);
  const again = () => { if (o.includes('after CONT') || c.exitCode !== null || c.signalCode !== null) return; c.kill('SIGCONT'); timer = setTimeout(again, 100); };
  again();
};
const waitStopped = (left) => { const s = stopped(); if (s === null || s || left <= 0) return setTimeout(cont, 1000); setTimeout(() => waitStopped(left - 1), 20); };
c.stdout.on('data', (d) => { o += d; if (!started && o.includes('before stop')) { started = true; waitStopped(500); } });
c.on('exit', (code, sig) => { clearTimeout(timer); console.log('child exit', code, sig, JSON.stringify(o)); });
