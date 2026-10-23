const cp = require('child_process');
const fs = require('fs');
const out = 'w-shared.txt';
const busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };
const prog = 'process.stderr.write("err 1\\n"); process.stdout.write("out 1\\n"); process.stderr.write("err 2\\n"); process.stdout.write("out 2\\n");';
let fd = fs.openSync(out, 'w');
cp.spawnSync('node', ['-e', prog], { stdio: ['ignore', fd, fd] });
fs.closeSync(fd);
console.log('spawnSync', JSON.stringify(fs.readFileSync(out, 'utf8')));
fd = fs.openSync(out, 'w');
const c = cp.spawn('node', ['-e', prog], { stdio: ['ignore', fd, fd] });
busy(1500);
c.on('close', () => {
  fs.closeSync(fd);
  console.log('spawn', JSON.stringify(fs.readFileSync(out, 'utf8')));
  fs.rmSync(out);
});
