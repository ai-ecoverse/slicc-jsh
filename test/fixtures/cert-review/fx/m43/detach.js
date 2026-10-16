const cp = require('child_process'); const { info, alive } = require('./ps.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const me = info(process.pid);
const rel = (k) => { const i = info(k.pid); return { ownGroup: i.pgid === i.pid, sessionLeader: /s/.test(i.stat), sameGroupAsParent: i.pgid === me.pgid }; };
const line = (l, o) => console.log(l, JSON.stringify(o));
(async () => {
  for (const detached of [false, true]) {
    const c = cp.spawn(process.execPath, ['kid.js', 'plain'], { detached, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; c.stdout.on('data', (d) => (out += d));
    await sleep(400); line(`spawn detached=${detached}`, rel(c));
    await new Promise((r) => c.on('close', r)); line(`  child says`, JSON.parse(out));
  }
  const g = cp.spawn(process.execPath, ['kid.js', 'grand'], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let gout = ''; g.stdout.on('data', (d) => (gout += d)); for (let i = 0; i < 50 && !gout.includes('}'); i++) await sleep(200); await sleep(300);
  const grand = JSON.parse(gout).grand;
  line('grandchild in detached child group', { sameGroup: info(grand).pgid === g.pid });
  process.kill(-g.pid, 'SIGTERM'); await sleep(600);
  line('kill(-child.pid) reached', { child: !alive(g.pid) || 'alive', grandchild: !alive(grand) || 'alive' });
  const k = cp.spawn(process.execPath, ['kid.js', 'kill0'], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let kout = ''; k.stdout.on('data', (d) => (kout += d));
  process.on('SIGTERM', () => line('PARENT GOT SIGTERM from the child kill(0)', {}));
  await new Promise((r) => k.on('close', r)); await sleep(200); line('child kill(0)', { child: JSON.parse(kout).kill0, parentSpared: true });
  try { cp.spawn(process.execPath, ['-e', '1'], { detached: 'yes' }); line('detached:"yes"', 'accepted'); } catch (e) { line('detached:"yes"', e.code); }
  const r = cp.spawnSync(process.execPath, ['-e', 'const { info } = require("./ps.js"); const i = info(process.pid); console.log(JSON.stringify({ ownGroup: i.pgid === i.pid, sessionLeader: /s/.test(i.stat) }))'], { detached: true, encoding: 'utf8' });
  line('spawnSync detached=true', JSON.parse(r.stdout || '{}'));
  const r2 = cp.spawnSync(process.execPath, ['-e', 'const { info } = require("./ps.js"); const i = info(process.pid); console.log(JSON.stringify({ ownGroup: i.pgid === i.pid }))'], { encoding: 'utf8' });
  line('spawnSync detached=false', JSON.parse(r2.stdout || '{}'));
  const opts = { env: { ...process.env, SNAP: 'before' }, detached: false };
  const s = cp.spawn(process.execPath, ['-e', 'console.log(process.env.SNAP)'], opts); opts.env.SNAP = 'after'; opts.detached = true;
  let sout = ''; s.stdout.on('data', (d) => (sout += d)); await new Promise((r) => s.on('close', r)); line('env snapshot', sout.trim());
})();
