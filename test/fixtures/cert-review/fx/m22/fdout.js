const cp = require('child_process'); const fs = require('fs');
const T = '/tmp/m22'; fs.mkdirSync(T, { recursive: true });
const rd = (p) => JSON.stringify(fs.readFileSync(p, 'utf8'));
// spawnSync to a file fd, writes before and after (shared offset)
let fd = fs.openSync(`${T}/a.txt`, 'w'); fs.writeSync(fd, 'before\n');
let r = cp.spawnSync('sh', ['-c', 'echo child-out'], { stdio: ['ignore', fd, 'pipe'] }); fs.writeSync(fd, 'after\n'); fs.closeSync(fd);
console.log('spawnSync fd', r.status, r.error && r.error.code, rd(`${T}/a.txt`));
// execFileSync to an fd
fd = fs.openSync(`${T}/b.txt`, 'w'); const ret = cp.execFileSync('printf', ['%s', 'exec-file'], { stdio: ['ignore', fd, 'pipe'] }); fs.closeSync(fd);
console.log('execFileSync fd', JSON.stringify(ret), rd(`${T}/b.txt`));
// 3 MB, no maxBuffer
fd = fs.openSync(`${T}/c.bin`, 'w'); r = cp.spawnSync('head', ['-c', '3000000', '/dev/zero'], { stdio: ['ignore', fd, 'pipe'], maxBuffer: 10 }); fs.closeSync(fd);
console.log('3MB to fd, maxBuffer 10', r.status, r.error && r.error.code, fs.statSync(`${T}/c.bin`).size);
// append-mode fd
fs.writeFileSync(`${T}/d.txt`, 'existing\n'); fd = fs.openSync(`${T}/d.txt`, 'a');
cp.spawnSync('sh', ['-c', 'echo appended'], { stdio: ['ignore', fd, 'inherit'] }); fs.writeSync(fd, 'parent-append\n'); fs.closeSync(fd);
console.log('append fd', rd(`${T}/d.txt`));
// stderr to an fd
fd = fs.openSync(`${T}/e.txt`, 'w'); r = cp.spawnSync('sh', ['-c', 'echo to-err >&2; echo to-out'], { stdio: ['ignore', 'pipe', fd] }); fs.closeSync(fd);
console.log('stderr fd', JSON.stringify(String(r.stdout)), rd(`${T}/e.txt`));
// a positioned fd: write at an offset first
fs.writeFileSync(`${T}/f.txt`, '0123456789'); fd = fs.openSync(`${T}/f.txt`, 'r+'); fs.readSync(fd, Buffer.alloc(4), 0, 4, null);
cp.spawnSync('printf', ['XY'], { stdio: ['ignore', fd, 'inherit'] }); fs.closeSync(fd);
console.log('r+ fd after reading 4', rd(`${T}/f.txt`));
// stdin from an fd after a partial read
fs.writeFileSync(`${T}/in.txt`, 'line1\nline2\nline3\n'); fd = fs.openSync(`${T}/in.txt`, 'r'); fs.readSync(fd, Buffer.alloc(6), 0, 6, null);
r = cp.spawnSync('cat', { stdio: [fd, 'pipe', 'pipe'] }); fs.closeSync(fd);
console.log('stdin fd after partial read', JSON.stringify(String(r.stdout)));
fd = fs.openSync(`${T}/in.txt`, 'r'); console.log('execSync stdin fd', JSON.stringify(cp.execSync('wc -l', { stdio: [fd, 'pipe', 'pipe'] }).toString().trim())); fs.closeSync(fd);
