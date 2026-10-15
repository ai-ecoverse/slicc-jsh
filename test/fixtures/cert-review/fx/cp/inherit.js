const { spawn } = require('child_process');
const c = spawn('sh', ['-c', 'echo out-line; echo err-line >&2; exit 3'], { stdio: 'inherit' });
c.on('exit', (code, sig) => console.log('exit', code, sig));
c.on('close', (code, sig) => console.log('close', code, sig, 'pid', typeof c.pid, 'exitCode', c.exitCode, 'signalCode', c.signalCode, 'stdout', c.stdout));
