const cp = require('child_process');
const step = (detached) => new Promise((resolve) => {
  const c = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', detached });
  c.on('spawn', () => {
    try { console.log('kill(-pid)', detached, process.kill(-c.pid, 'SIGTERM')); }
    catch (e) { console.log('kill(-pid)', detached, e.code); c.kill(); }
  });
  c.on('exit', (code, sig) => { console.log('exit', detached, code, sig); resolve(); });
});
(async () => {
  await step(false);
  await step(true);
  const r = cp.spawnSync(process.execPath, ['-e', 'try { process.kill(0, "SIGTERM"); } finally { console.log("alive?") }'], { detached: true, encoding: 'utf8' });
  console.log('spawnSync detached kill(0)', r.status, r.signal);
  console.log('parent still here');
  try { cp.spawn('x', { detached: 'yes' }); } catch (e) { console.log(e.code, e.message); }
  // Options are taken in spawn() itself: changing them afterwards does nothing.
  const o = { stdio: ['ignore', 'pipe', 'ignore'], detached: true, env: { ...process.env, MARK: 'before' } };
  const c = cp.spawn(process.execPath, ['-e', 'console.log(process.env.MARK); setTimeout(() => {}, 20000)'], o);
  o.detached = false;
  o.env.MARK = 'after';
  c.stdout.once('data', (d) => {
    console.log('env taken at spawn()', String(d).trim());
    try { console.log('detached taken at spawn()', process.kill(-c.pid, 'SIGTERM')); } catch (e) { console.log('detached taken at spawn()', e.code); c.kill(); }
  });
  c.on('exit', (code, sig) => console.log('exit', code, sig));
})();
