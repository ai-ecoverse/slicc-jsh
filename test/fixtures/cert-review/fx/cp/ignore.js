const { spawn } = require('child_process');
const c = spawn('sh', ['-c', 'echo should-not-show; exit 0'], { stdio: 'ignore' });
c.on('close', (code) => console.log('ignore close', code, c.stdout, c.stderr, c.stdin));
const d = spawn('sh', ['-c', 'echo partial; exit 0'], { stdio: ['ignore', 'pipe', 'inherit'] });
d.stdout.on('data', (x) => console.log('partial pipe got', JSON.stringify(String(x))));
