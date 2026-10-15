const { spawn } = require('child_process');
spawn('sh', ['-c', 'exit 5'], { stdio: 'inherit' }).on('exit', (code) => { console.log('child exit', code, '-> process.exit'); process.exit(code); });
