const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fsrv-'));
process.chdir(work);
const err = (e) => `${e.name} ${e.code} ${JSON.stringify(e.message)}`;
const sync = (label, f) => {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, 'THROW', err(e));
  }
};
const s = (bufs) => bufs.map((b) => JSON.stringify(Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1'))).join(' ');
(async () => {
  let fd = fs.openSync('f.txt', 'w+');
  sync('writevSync', () => fs.writevSync(fd, [Buffer.from('hello '), new Uint8Array([119, 111]), new DataView(new TextEncoder().encode('rld').buffer)]));
  sync('writevSync empty', () => fs.writevSync(fd, []));
  sync('writevSync at 0', () => fs.writevSync(fd, [Buffer.from('J')], 0));
  sync('writevSync position string', () => fs.writevSync(fd, [Buffer.from('!')], '1'));
  sync('content', () => fs.readFileSync('f.txt', 'latin1'));
  let bufs = [Buffer.alloc(3), Buffer.alloc(4), Buffer.alloc(10)];
  sync('readvSync at 0', () => [fs.readvSync(fd, bufs, 0), s(bufs)].join(' '));
  bufs = [Buffer.alloc(2), Buffer.alloc(2)];
  sync('readvSync at 9', () => [fs.readvSync(fd, bufs, 9), s(bufs)].join(' '));
  sync('readvSync at end', () => fs.readvSync(fd, [Buffer.alloc(2)]));
  sync('readvSync past end', () => fs.readvSync(fd, [Buffer.alloc(2)], 100));
  sync('readvSync empty list', () => fs.readvSync(fd, []));
  fs.closeSync(fd);
  fd = fs.openSync('f.txt', 'r');
  bufs = [Buffer.alloc(5), Buffer.alloc(1)];
  sync('readvSync current position', () => [fs.readvSync(fd, bufs), s(bufs), fs.readvSync(fd, [Buffer.alloc(3)])].join(' '));
  sync('writevSync read-only', () => fs.writevSync(fd, [Buffer.from('x')]));
  fs.closeSync(fd);
  sync('readvSync closed', () => fs.readvSync(fd, [Buffer.alloc(1)]));
  sync('writevSync closed', () => fs.writevSync(fd, [Buffer.alloc(1)]));
  sync('readvSync not array', () => fs.readvSync(0, Buffer.alloc(1)));
  sync('readvSync string item', () => fs.readvSync(0, ['x']));
  sync('writevSync string item', () => fs.writevSync(1, [Buffer.from('a'), 'b']));
  sync('writevSync bad fd', () => fs.writevSync(-1, []));
  sync('readvSync bad fd', () => fs.readvSync('1', []));
  sync('readv no cb', () => fs.readv(0, []));
  sync('writev no cb', () => fs.writev(1, [], 0));
  sync('writev bad cb', () => fs.writev(1, [], 0, 'x'));
  fd = fs.openSync('g.txt', 'a+');
  fs.writevSync(fd, [Buffer.from('ab')]);
  fs.writevSync(fd, [Buffer.from('cd')]);
  sync('append mode', () => fs.readFileSync('g.txt', 'latin1'));
  await new Promise((resolve) =>
    fs.writev(fd, [Buffer.from('E'), Buffer.from('F')], (e, n, b) => {
      console.log('writev(cb)', e, n, s(b));
      resolve();
    })
  );
  await new Promise((resolve) =>
    fs.writev(fd, [], (e, n, b) => {
      console.log('writev(cb) empty', e, n, b.length);
      resolve();
    })
  );
  await new Promise((resolve) => {
    const out = [Buffer.alloc(4), Buffer.alloc(4)];
    fs.readv(fd, out, 0, (e, n, b) => {
      console.log('readv(cb)', e, n, s(b), b === out);
      resolve();
    });
  });
  console.log('promisify(readv)', JSON.stringify(Object.keys(await util.promisify(fs.readv)(fd, [Buffer.alloc(1)], 0))));
  console.log('promisify(writev)', JSON.stringify(Object.keys(await util.promisify(fs.writev)(fd, [Buffer.alloc(1)]))));
  fs.closeSync(fd);
  await new Promise((resolve) =>
    fs.readv(fd, [Buffer.alloc(1)], (e, n, b) => {
      console.log('readv(cb) closed', err(e), e.syscall, n, b.length);
      resolve();
    })
  );
  const fh = await fs.promises.open('h.txt', 'w+');
  const w = await fh.writev([Buffer.from('12'), Buffer.from('345')]);
  console.log('fh.writev', w.bytesWritten, s(w.buffers), Object.getPrototypeOf(w), Object.keys(w).join());
  const we = await fh.writev([]);
  console.log('fh.writev empty', we.bytesWritten, we.buffers.length);
  const r = await fh.readv([Buffer.alloc(2), Buffer.alloc(9)], 1);
  console.log('fh.readv', r.bytesRead, s(r.buffers), Object.getPrototypeOf(r), Object.keys(r).join());
  console.log('fh.readv end', (await fh.readv([Buffer.alloc(2)])).bytesRead);
  await fh.readv('x').catch((e) => console.log('fh.readv bad', err(e)));
  await fh.writev(['x']).catch((e) => console.log('fh.writev bad', err(e)));
  await fh.close();
  await fh.readv([Buffer.alloc(1)]).catch((e) => console.log('fh.readv closed', err(e), e.syscall));
  await fh.writev([Buffer.alloc(1)]).catch((e) => console.log('fh.writev closed', err(e), e.syscall));
  fs.rmSync(work, { recursive: true });
})();
