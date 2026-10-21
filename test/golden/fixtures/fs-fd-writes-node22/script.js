const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-writes-'));
const f = path.join(dir, 'f');
const show = (label) => console.log(label, JSON.stringify(fs.readFileSync(f, 'latin1')), fs.statSync(f).size);
fs.writeFileSync(f, 'abcdef');
let fd = fs.openSync(f, 'r+');
console.log('written', fs.writeSync(fd, 'XY'));
show('at the position');
fs.writeSync(fd, 'Z');
show('the position moved');
fs.writeSync(fd, 'Q', 10);
show('past the end');
fs.writeSync(fd, 'W');
show('a positional write keeps the position');
fs.writeSync(fd, Buffer.from('0123'), 1, 2, 0);
show('a buffer slice at 0');
fs.ftruncateSync(fd, 4);
show('ftruncate shorter');
fs.ftruncateSync(fd, 6);
show('ftruncate longer');
fs.ftruncateSync(fd, -1);
show('ftruncate -1');
fs.closeSync(fd);
fs.writeFileSync(f, 'abcdefghij');
fd = fs.openSync(f, 'r+');
fs.readSync(fd, Buffer.alloc(6), 0, 6, null);
fs.ftruncateSync(fd, 4);
fs.writeSync(fd, 'XYZ');
show('ftruncate below the position, then a write');
fs.closeSync(fd);
fs.writeFileSync(f, 'hello');
fs.writeFileSync(f, 'xy', { flag: 'r+' });
show("writeFileSync 'r+'");
try {
  fs.writeFileSync(path.join(dir, 'missing'), 'x', { flag: 'r+' });
} catch (e) {
  console.log("'r+' on a missing file", e.code, e.syscall);
}
fd = fs.openSync(f, 'r');
try {
  fs.writeSync(fd, 'x');
} catch (e) {
  console.log('a read-only descriptor', e.code, e.syscall);
}
fs.closeSync(fd);
fd = fs.openSync(f, 'w+');
fs.writeSync(fd, 'new');
show("'w+'");
fs.closeSync(fd);
const s = path.join(dir, 's');
const ws = fs.createWriteStream(s);
ws.write('one ');
ws.end('two', () => {
  console.log('a write stream', JSON.stringify(fs.readFileSync(s, 'utf8')));
  fs.rmSync(dir, { recursive: true });
});
