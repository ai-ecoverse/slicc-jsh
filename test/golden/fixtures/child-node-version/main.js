const cp = require('child_process');
console.log('self', process.version);
console.log('node on PATH', cp.execFileSync('node', ['-p', 'process.version'], { encoding: 'utf8' }).trim());
console.log('execPath', cp.execFileSync(process.execPath, ['-p', 'process.version'], { encoding: 'utf8' }).trim());
