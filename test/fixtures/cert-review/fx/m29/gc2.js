const cp = require('child_process');
const r = cp.spawnSync('sh', ['-c', '(sleep 0.3; while :; do echo tick; done) & sleep 5'], { timeout: 200 });
console.log('spawnSync timeout', r.error && r.error.code, r.signal);
try { cp.execSync('yes; true', { maxBuffer: 50 }); } catch (e) { console.log('execSync maxBuffer', e.code); }
