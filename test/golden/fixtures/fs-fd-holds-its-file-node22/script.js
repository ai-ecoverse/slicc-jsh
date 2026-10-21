const fs = require('fs');
const path = require('path');
const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'held-'));
const at = (n) => path.join(dir, n);
const buf = Buffer.alloc(16);
const readAll = (fd) => JSON.stringify(buf.toString('latin1', 0, fs.readSync(fd, buf, 0, 16, 0)));

fs.writeFileSync(at('u'), 'abc');
let fd = fs.openSync(at('u'), 'r+');
fs.unlinkSync(at('u'));
fs.writeSync(fd, 'XY');
console.log('unlinked: the path is back', fs.existsSync(at('u')), 'the descriptor reads', readAll(fd), 'nlink', fs.fstatSync(fd).nlink, 'size', fs.fstatSync(fd).size);
fs.ftruncateSync(fd, 1);
console.log('unlinked: ftruncate', readAll(fd), fs.existsSync(at('u')));
fs.closeSync(fd);

fs.writeFileSync(at('f'), 'old');
fd = fs.openSync(at('f'), 'r+');
fs.writeFileSync(at('g'), 'new file');
fs.renameSync(at('g'), at('f'));
fs.writeSync(fd, 'XY');
fs.ftruncateSync(fd, 2);
console.log('replaced: the path', JSON.stringify(fs.readFileSync(at('f'), 'utf8')), 'the descriptor reads', readAll(fd), 'nlink', fs.fstatSync(fd).nlink);
fs.closeSync(fd);

fs.writeFileSync(at('a'), 'old');
fd = fs.openSync(at('a'), 'a');
fs.writeFileSync(at('b'), 'new');
fs.renameSync(at('b'), at('a'));
fs.writeSync(fd, '+');
fs.appendFileSync(fd, '!');
console.log('replaced, appending: the path', JSON.stringify(fs.readFileSync(at('a'), 'utf8')));
fs.closeSync(fd);

fs.writeFileSync(at('w'), 'old');
fd = fs.openSync(at('w'), 'w');
fs.renameSync(at('w'), at('moved'));
fs.writeSync(fd, 'to the moved one');
fs.closeSync(fd);
console.log('renamed away while open for w:', JSON.stringify(fs.readFileSync(at('moved'), 'utf8')), fs.existsSync(at('w')));

const ws = fs.createWriteStream(at('s'));
ws.on('open', () => {
  fs.renameSync(at('s'), at('s2'));
  ws.end('stream after rename', () => {
    console.log('a write stream renamed away:', JSON.stringify(fs.readFileSync(at('s2'), 'utf8')), fs.existsSync(at('s')));
    fs.rmSync(dir, { recursive: true });
  });
});
