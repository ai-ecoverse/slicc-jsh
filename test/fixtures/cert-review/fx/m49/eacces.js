const fs = require('fs'), path = require('path'), cp = require('child_process');
const D = process.argv[2];
const n = (s) => typeof s === 'string' ? s.split(D).join('<D>') : Array.isArray(s) ? s.map(n) : s;
const er = (e) => `${e.name}|${e.code}|${e.errno}|${n(e.syscall)}|${n(e.path)}|${JSON.stringify(n(e.spawnargs))}|${n(e.message)}`;
const s = path.join(D, 'nx.sh'), dir = path.join(D, 'adir'), ok = path.join(D, 'ok.sh');
fs.rmSync(s, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(ok, { force: true });
fs.writeFileSync(s, '#!/bin/sh\necho ran\n'); fs.mkdirSync(dir); fs.writeFileSync(ok, '#!/bin/sh\necho ok-ran\n'); fs.chmodSync(ok, 0o755);
(async () => {
  for (const [l, p] of [['644 script', s], ['directory', dir]]) {
    const r = cp.spawnSync(p, ['a1'], { encoding: 'utf8' });
    console.log(l, 'spawnSync', r.error ? er(r.error) : 'no error', 'status', r.status, 'pid', typeof r.pid, r.pid === 0 ? 0 : 'nz');
    try { cp.execFileSync(p, ['a2']); console.log(l, 'execFileSync no throw'); } catch (e) { console.log(l, 'execFileSync', er(e), 'status', e.status); }
    await new Promise((res) => { const c = cp.spawn(p, ['a3']); console.log(l, 'spawn returned pid', typeof c.pid); c.on('error', (e) => { console.log(l, 'spawn error', er(e), 'pid', typeof c.pid); }); c.on('close', (code, sig) => { console.log(l, 'spawn close', code, sig); res(); }); setTimeout(res, 3000); });
    await new Promise((res) => cp.execFile(p, ['a4'], (e, o) => { console.log(l, 'execFile cb', e ? er(e) : 'ok ' + o.trim()); res(); }));
    await new Promise((res) => cp.exec(`${p} a5`, (e, o, se) => { console.log(l, 'exec(shell) code', e && e.code, JSON.stringify(n(se.trim()))); res(); }));
  }
  const c = cp.spawn(ok, ['p']); const at = typeof c.pid; let sp; c.on('spawn', () => { sp = typeof c.pid; });
  let o = ''; c.stdout.on('data', (b) => o += b);
  await new Promise((res) => c.on('close', (code) => { console.log('ok spawn pid at return', at, 'at spawn event', sp, 'code', code, o.trim()); res(); }));
  const c2 = cp.spawn(process.execPath, ['-e', '0']); console.log('node child pid at return', typeof c2.pid, Number.isInteger(c2.pid) && c2.pid > 0); await new Promise((r) => c2.on('close', r));
  const c3 = cp.spawn('no-such-cmd-zz'); console.log('missing pid at return', typeof c3.pid); c3.on('error', (e) => console.log('missing error', er(e)));
})();
