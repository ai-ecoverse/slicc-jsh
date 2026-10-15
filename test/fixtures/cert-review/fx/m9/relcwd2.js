const cp = require('child_process'); const fs = require('fs'); const path = require('path'); const { promisify } = require('util');
fs.rmSync('w-rc2', { recursive: true, force: true }); fs.mkdirSync('w-rc2/a/b', { recursive: true }); fs.writeFileSync('w-rc2/a/b/m', 'B'); fs.writeFileSync('w-rc2/a/m', 'A');
const C = (s) => String(s).split(process.cwd()).join('CWD').trim();
const cmd = 'pwd; cat m';
const cwds = ['w-rc2/a/b', './w-rc2/a', 'w-rc2/a/b/..', path.resolve('w-rc2/a/b'), 'w-rc2/nope', '/nonexistent-zz/abs', 'w-rc2/a/m'];
(async () => {
  for (const cwd of cwds) {
    const row = [];
    const S = (f) => new Promise((r) => { try { f(r); } catch (e) { r(`SYNC-THROW ${e.code} ${e.syscall ?? ''}`); } });
    const ef = await S((r) => cp.execFile('sh', ['-c', cmd], { cwd }, (e, o, s) => r(e ? `ERR ${e.code} ${e.syscall ?? ''} ${C(e.path ?? '')}` : C(o).replace(/\n/g, ':'))));
    row.push(`execFile=${ef}`);
    const ex = await S((r) => cp.exec(cmd, { cwd }, (e, o) => r(e ? `ERR ${e.code} ${e.syscall ?? ''}` : C(o).replace(/\n/g, ':'))));
    row.push(`exec=${ex}`);
    const sp = await S((r) => { let o = ''; const c = cp.spawn('sh', ['-c', cmd], { cwd }); c.stdout.on('data', (d) => (o += d)); c.on('error', (e) => r(`ERR ${e.code} ${e.syscall} ${C(e.path ?? '')} ${C(e.spawnargs ?? '')}`)); c.on('close', (code) => r(code === null ? 'closed-null' : `${C(o).replace(/\n/g, ':')} rc=${code}`)); });
    row.push(`spawn=${sp}`);
    try { const r = await promisify(cp.execFile)('sh', ['-c', cmd], { cwd }); row.push(`pexecFile=${C(r.stdout).replace(/\n/g, ':')}`); } catch (e) { row.push(`pexecFile=ERR ${e.code}`); }
    for (const [n, f] of [['execFileSync', () => cp.execFileSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', stdio: 'pipe' })], ['execSync', () => cp.execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' })], ['spawnSync', () => { const r = cp.spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' }); return r.error ? `ERR ${r.error.code} ${r.error.syscall}` : r.stdout; }]]) { try { row.push(`${n}=${C(f()).replace(/\n/g, ':')}`); } catch (e) { row.push(`${n}=ERR ${e.code ?? e.status} ${e.syscall ?? ''} ${String(e.message).split('\n')[0].slice(0, 60)}`); } }
    console.log(`cwd ${C(cwd).padEnd(16)} ${row.join(' | ')}`);
  }
  fs.rmSync('w-rc2', { recursive: true, force: true });
})();
