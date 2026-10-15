const cp = require('child_process');
const SCRIPT = 'echo o1; echo e1 >&2; echo o2; echo e2 >&2; echo o3';
console.log('--spawnSync [ignore, inherit, 1]'); cp.spawnSync('sh', ['-c', SCRIPT], { stdio: ['ignore', 'inherit', 1] });
console.log('--execSync [ignore, 1, 1]'); cp.execSync(SCRIPT, { stdio: ['ignore', 1, 1] });
console.log('--stdout to fd 2'); cp.spawnSync('sh', ['-c', 'echo to-two'], { stdio: ['ignore', 2, 'inherit'] });
console.log('--end');
