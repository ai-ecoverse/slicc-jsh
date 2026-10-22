const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-read-'));
const f = path.join(dir, 'f');
const b = Buffer.alloc(16);
const read = (fd, n) => b.toString('latin1', 0, fs.readSync(fd, b, 0, n, null));
fs.writeFileSync(f, 'abcdef');
let fd = fs.openSync(f, 'a+');
console.log('first read', JSON.stringify(read(fd, 3)));
console.log('readFileSync(fd)', JSON.stringify(fs.readFileSync(fd, 'latin1')));
console.log('at the end', JSON.stringify(read(fd, 3)));
fs.closeSync(fd);
fd = fs.openSync(f, 'a+');
console.log('written', fs.writeSync(fd, 'XY'));
console.log('after the write', JSON.stringify(read(fd, 4)));
console.log('at 0', b.toString('latin1', 0, fs.readSync(fd, b, 0, 16, 0)));
console.log('size', fs.fstatSync(fd).size);
fs.closeSync(fd);
fd = fs.openSync(f, 'a+');
console.log('readFileSync(fd) fresh', JSON.stringify(fs.readFileSync(fd, 'latin1')));
fs.closeSync(fd);
(async () => {
  const fh = await fs.promises.open(f, 'a+');
  const r = await fh.read(Buffer.alloc(4), 0, 4, null);
  console.log('FileHandle.read', r.bytesRead, JSON.stringify(r.buffer.toString('latin1', 0, r.bytesRead)));
  console.log('FileHandle.readFile', JSON.stringify(await fh.readFile('latin1')));
  await fh.close();
  fd = fs.openSync(f, 'a+');
  let streamed = '';
  fs.createReadStream(null, { fd, encoding: 'latin1' })
    .on('data', (d) => (streamed += d))
    .on('close', () => {
      console.log('read stream', JSON.stringify(streamed));
      fs.rmSync(dir, { recursive: true, force: true });
    });
})();
