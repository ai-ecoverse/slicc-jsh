const cp = require('child_process'); const fs = require('fs');
const SCRIPT = 'echo o1; echo e1 >&2; echo o2; echo e2 >&2; echo o3';
let fd = fs.openSync('/tmp/m29a.txt', 'w'); cp.spawnSync('sh', ['-c', SCRIPT], { stdio: ['ignore', fd, fd] }); fs.closeSync(fd);
console.log('spawnSync file fd order', JSON.stringify(fs.readFileSync('/tmp/m29a.txt', 'utf8')));
fd = fs.openSync('/tmp/m29b.txt', 'w'); cp.execFileSync('sh', ['-c', SCRIPT], { stdio: ['ignore', fd, fd] }); fs.closeSync(fd);
console.log('execFileSync file fd order', JSON.stringify(fs.readFileSync('/tmp/m29b.txt', 'utf8')));
