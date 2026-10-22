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
fd = fs.openSync(at('a'), 'a+');
fs.writeFileSync(at('b'), 'new');
fs.renameSync(at('b'), at('a'));
fs.writeSync(fd, '+');
fs.appendFileSync(fd, '!');
console.log('replaced, appending: the path', JSON.stringify(fs.readFileSync(at('a'), 'utf8')), 'the descriptor reads', readAll(fd));
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
    later().then(() => fs.rmSync(dir, { recursive: true }));
  });
});

const replaceWith = (n, data) => {
  fs.writeFileSync(at('tmp'), data);
  fs.renameSync(at('tmp'), at(n));
};

async function later() {
  fs.writeFileSync(at('cu'), 'abc');
  fd = fs.openSync(at('cu'), 'r+');
  fs.unlinkSync(at('cu'));
  await new Promise((resolve, reject) => fs.write(fd, 'XY', (err, n) => (err ? reject(err) : resolve(n))));
  console.log('unlinked: fs.write', fs.existsSync(at('cu')), 'the descriptor reads', readAll(fd));
  fs.closeSync(fd);

  fs.writeFileSync(at('cr'), 'old');
  fd = fs.openSync(at('cr'), 'r+');
  replaceWith('cr', 'new file');
  await new Promise((resolve, reject) => fs.write(fd, Buffer.from('XY'), 0, 2, 1, (err) => (err ? reject(err) : resolve())));
  console.log('replaced: fs.write at 1', JSON.stringify(fs.readFileSync(at('cr'), 'utf8')), 'the descriptor reads', readAll(fd));
  fs.closeSync(fd);

  fs.writeFileSync(at('hu'), 'abcdef');
  let fh = await fs.promises.open(at('hu'), 'r+');
  fs.unlinkSync(at('hu'));
  await fh.write('XY');
  await fh.truncate(4);
  console.log('unlinked: FileHandle.write and truncate', fs.existsSync(at('hu')), 'the handle reads', readAll(fh.fd), 'size', (await fh.stat()).size, 'nlink', (await fh.stat()).nlink);
  await fh.close();

  fs.writeFileSync(at('hr'), 'abcdef');
  fh = await fs.promises.open(at('hr'), 'r+');
  replaceWith('hr', 'new file');
  await fh.write('XY', 2);
  await fh.truncate(3);
  console.log('replaced: FileHandle.write and truncate', JSON.stringify(fs.readFileSync(at('hr'), 'utf8')), 'the handle reads', readAll(fh.fd));
  await fh.close();

  fh = await fs.promises.open(at('ha'), 'a');
  fs.renameSync(at('ha'), at('ha2'));
  await fh.appendFile('appended');
  await fh.close();
  console.log('renamed away: FileHandle.appendFile', JSON.stringify(fs.readFileSync(at('ha2'), 'utf8')), fs.existsSync(at('ha')));

  fs.writeFileSync(at('hw'), 'abcdefgh');
  fh = await fs.promises.open(at('hw'), 'r+');
  await fh.write('12');
  replaceWith('hw', 'new file');
  await fh.writeFile('XY');
  await fh.appendFile('Z');
  await fs.promises.writeFile(fh, 'W');
  await fs.promises.appendFile(fh, 'V', 'utf8');
  console.log('replaced: FileHandle.writeFile and appendFile', JSON.stringify(fs.readFileSync(at('hw'), 'utf8')), 'the handle reads', JSON.stringify(await fh.readFile('latin1')), readAll(fh.fd));
  await fh.close();

  fd = fs.openSync(at('x'), 'wx');
  try {
    fs.openSync(at('x'), 'wx');
  } catch (e) {
    console.log('wx again:', e.code, e.syscall);
  }
  replaceWith('x', 'new');
  fs.writeSync(fd, 'excl');
  fs.closeSync(fd);
  console.log('wx, replaced: the path', JSON.stringify(fs.readFileSync(at('x'), 'utf8')));

  fd = fs.openSync(at('xp'), 'wx+');
  fs.unlinkSync(at('xp'));
  fs.writeSync(fd, 'excl+');
  console.log('wx+, unlinked:', fs.existsSync(at('xp')), 'the descriptor reads', readAll(fd));
  fs.closeSync(fd);

  fs.writeFileSync(at('t'), 'a long old content');
  fd = fs.openSync(at('t'), 'w+');
  console.log('w+ truncates: size', fs.fstatSync(fd).size, JSON.stringify(fs.readFileSync(at('t'), 'utf8')));
  replaceWith('t', 'new');
  fs.writeSync(fd, 'trunc');
  console.log('w+, replaced: the path', JSON.stringify(fs.readFileSync(at('t'), 'utf8')), 'the descriptor reads', readAll(fd));
  fs.closeSync(fd);
}
