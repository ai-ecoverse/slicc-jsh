const fs = require('fs'); const T = process.argv[2];
process.on('exit', (c) => { fs.writeFileSync(T + '.exitlistener', 'code ' + c); console.log('exit listener', c, process.exitCode); process.exitCode = 9; });
try { process.exit(3); } finally { fs.writeFileSync(T + '.finally', 'x'); }
