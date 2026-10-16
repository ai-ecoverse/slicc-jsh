const cp = require('child_process'); const fs = require('fs');
fs.rmSync('/tmp/m29gc', { force: true });
const r = cp.spawnSync('sh', ['-c', '(sleep 0.5; i=0; while [ $i -lt 400 ]; do echo tick || { echo "gc-write-failed" > /tmp/m29gc; exit 3; }; i=$((i+1)); sleep 0.01; done; echo "gc-never-failed" > /tmp/m29gc) & sleep 5'], { timeout: 300 });
console.log('spawnSync timeout', r.error && r.error.code, r.signal);
setTimeout(() => { let s; try { s = fs.readFileSync('/tmp/m29gc', 'utf8').trim(); } catch { s = 'no file yet'; } console.log('grandchild after 6 s:', s); }, 6000);
