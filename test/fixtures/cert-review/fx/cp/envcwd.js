const { spawn } = require('child_process');
process.env.PARENT_VAR = 'from-parent';
const c = spawn('sh', ['-c', 'echo "$PARENT_VAR|$ONLY_CHILD|$(pwd)"'], { cwd: '/tmp' });
let o = ''; c.stdout.on('data', (d) => (o += d));
c.on('close', () => {
  console.log('inherit env + cwd', JSON.stringify(o.replace('/private', '')));
  const d = spawn('sh', ['-c', 'echo "[$PARENT_VAR][$ONLY_CHILD]"'], { env: { ONLY_CHILD: 'yes', PATH: process.env.PATH } });
  let p = ''; d.stdout.on('data', (x) => (p += x)); d.on('close', () => {
    console.log('explicit env', JSON.stringify(p));
    const e = spawn('echo "shell:$ONLY_CHILD"', { shell: true, env: { ONLY_CHILD: 'z', PATH: process.env.PATH } });
    let q = ''; e.stdout.on('data', (x) => (q += x)); e.on('close', () => console.log('shell:true', JSON.stringify(q)));
  });
});
