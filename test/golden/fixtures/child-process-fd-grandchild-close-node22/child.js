const cp = require('child_process');
const path = require('path');
cp.spawn(process.execPath, [path.join(__dirname, 'grand.js'), process.argv[2]], { stdio: 'inherit', detached: true }).unref();
process.stdout.write('x'.repeat(100000) + '\n');
console.error('child err');
