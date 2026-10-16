const fs = require('fs'); const T = process.argv[3] || '/tmp/sk';
process.on('exit', () => console.log('exit event'));
try { process.kill(process.pid, process.argv[2] || 'SIGTERM'); console.log('after kill (sync)'); } finally { fs.writeFileSync(T + '.finally', 'ran'); }
setTimeout(() => console.log('timer after kill'), 0);
