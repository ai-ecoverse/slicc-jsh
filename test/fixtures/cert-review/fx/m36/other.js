const cp = require('child_process');
const c = cp.spawn('sleep', ['5']);
c.on('spawn', () => {
  console.log('probe 0', process.kill(c.pid, 0));
  console.log('kill other', process.kill(c.pid, 'SIGTERM'));
});
c.on('exit', (code, sig) => {
  console.log('child exit', code, sig);
  try { process.kill(c.pid, 0); console.log('probe after exit: alive?'); } catch (e) { console.log('probe after exit', e.code, e.errno, e.syscall); }
  try { process.kill(999999, 'SIGTERM'); console.log('no esrch'); } catch (e) { console.log('kill 999999', e.code, e.errno, e.syscall, e.message); }
  try { process.kill(process.pid, 'SIGBOGUS'); } catch (e) { console.log('bogus', e.code, e.message); }
  try { process.kill('abc'); } catch (e) { console.log('bad pid', e.code); }
  const d = cp.spawn(process.execPath, ['-e', 'process.on("SIGUSR2", () => { console.log("child got USR2"); process.exit(7) }); setInterval(() => {}, 1000); console.log("ready")']);
  d.stdout.on('data', (b) => { const t = String(b).trim(); console.log('child says', t); if (t === 'ready') process.kill(d.pid, 'SIGUSR2'); });
  d.on('close', (code, sig) => console.log('handler child exit', code, sig));
});
