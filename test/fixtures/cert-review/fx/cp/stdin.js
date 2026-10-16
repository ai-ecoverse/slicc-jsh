const { spawn } = require('child_process');
const c = spawn('cat');
let o = '';
c.stdout.on('data', (d) => (o += d));
c.on('close', (code) => console.log('cat echoed', JSON.stringify(o), code));
c.stdin.write('line1\n'); setTimeout(() => { c.stdin.write('line2\n'); c.stdin.end('end\n'); }, 20);
