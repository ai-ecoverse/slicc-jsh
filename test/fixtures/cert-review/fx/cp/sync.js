const cp = require('child_process');
for (const [n, f] of [['execSync', () => cp.execSync('echo hi')], ['execFileSync', () => cp.execFileSync('echo', ['hi'])], ['spawnSync', () => cp.spawnSync('echo', ['hi'])], ['fork', () => cp.fork('./x.js')]]) {
  try { const r = f(); console.log(n, 'returned', r && (r.stdout ?? r).toString().trim().slice(0, 20)); } catch (e) { console.log(n, 'threw', e.code, e.name); }
}
