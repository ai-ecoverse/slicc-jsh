const cp = require('child_process');
try { cp.execSync('yes; true', { maxBuffer: 50 }); } catch (e) { console.log('execSync', e.code, e.signal, e.stdout.length); }
const r = cp.spawnSync('sh', ['-c', 'sleep 30; true'], { timeout: 200 }); console.log('spawnSync timeout', r.error && r.error.code, r.signal);
