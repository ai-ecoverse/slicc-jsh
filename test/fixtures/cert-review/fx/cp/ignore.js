const { spawn } = require('child_process');
// The second child starts from the first one's 'close': two children's
// events have no order of their own (host Node's flips under load, #236).
const c = spawn('sh', ['-c', 'echo should-not-show; exit 0'], { stdio: 'ignore' });
c.on('close', (code) => {
  console.log('ignore close', code, c.stdout, c.stderr, c.stdin);
  const d = spawn('sh', ['-c', 'echo partial; exit 0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  d.stdout.on('data', (x) => console.log('partial pipe got', JSON.stringify(String(x))));
});
