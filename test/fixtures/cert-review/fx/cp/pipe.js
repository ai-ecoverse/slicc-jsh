const { spawn } = require('child_process');
const c = spawn('sh', ['-c', 'echo out-line; echo err-line >&2; exit 4']);
let o = '', e = '';
c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (e += d));
c.on('close', (code, sig) => console.log('close', code, sig, JSON.stringify(o), JSON.stringify(e)));
