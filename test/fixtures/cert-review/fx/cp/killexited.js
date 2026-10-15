const { spawn } = require('child_process');
const c = spawn('sh', ['-c', 'exit 0']);
c.on('exit', () => { setTimeout(() => { try { console.log('kill after exit ->', c.kill()); } catch (e) { console.log('kill after exit threw', e.code, e.message); } }, 50); });
