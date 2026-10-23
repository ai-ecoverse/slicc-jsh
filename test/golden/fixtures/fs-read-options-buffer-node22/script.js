const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fsrob-'));
const file = path.join(work, 'f.txt');
fs.writeFileSync(file, 'abcdefghij');
const text = (buf, n) => JSON.stringify(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('latin1', 0, n));
const show = (label, bytesRead, buf, given) => console.log(label, bytesRead, buf.byteLength, given === undefined ? '' : buf === given ? 'same buffer' : 'other buffer', text(buf, Math.min(buf.byteLength, 12)));
const err = (label) => (e) => console.log(label, 'THROW', e.name, e.code);
const cbRead = (label, ...args) =>
  new Promise((resolve) => {
    const given = args.find((a) => ArrayBuffer.isView(a)) ?? args.find((a) => a && typeof a === 'object')?.buffer;
    fs.read(...args, (e, n, b) => {
      if (e) err(label)(e);
      else show(label, n, b, given);
      resolve();
    });
  });
(async () => {
  const fh = await fs.promises.open(file, 'r');
  const at = async (label, ...args) => {
    const given = ArrayBuffer.isView(args[0]) ? args[0] : args[0]?.buffer;
    try {
      const r = await fh.read(...args);
      show(label, r.bytesRead, r.buffer, given);
    } catch (e) {
      err(label)(e);
    }
  };
  await at('fh.read({ buffer, offset, length, position })', { buffer: Buffer.alloc(6, 46), offset: 1, length: 3, position: 4 });
  await at('fh.read({ buffer })', { buffer: Buffer.alloc(4, 46), position: 0 });
  await at('fh.read({ buffer: Uint8Array, position })', { buffer: new Uint8Array(5).fill(46), offset: 2, position: 8 });
  await at('fh.read({ length, position })', { length: 4, position: 2 });
  await at('fh.read({})', {});
  await at('fh.read({ buffer }) at the end', { buffer: Buffer.alloc(3, 46), position: 10 });
  await at('fh.read(buffer, { offset, length, position })', Buffer.alloc(6, 46), { offset: 2, length: 2, position: 1 });
  await at('fh.read(buffer, offset, length, position)', Buffer.alloc(6, 46), 0, 3, 6);
  await fh.close();
  for (const [label, args] of [['fh.read(null)', [null]], ['fh.read()', []]]) {
    const fresh = await fs.promises.open(file, 'r');
    const r = await fresh.read(...args);
    show(label, r.bytesRead, r.buffer);
    await fresh.close();
  }
  const fd = fs.openSync(file, 'r');
  await cbRead('fs.read(fd, { buffer, offset, length, position }, cb)', fd, { buffer: Buffer.alloc(6, 46), offset: 2, length: 2, position: 7 });
  await cbRead('fs.read(fd, { buffer }, cb)', fd, { buffer: Buffer.alloc(4, 46), position: 3 });
  await cbRead('fs.read(fd, { length, position }, cb)', fd, { length: 5, position: 1 });
  await cbRead('fs.read(fd, {}, cb)', fd, {});
  const own = fs.openSync(file, 'r');
  fs.readSync(own, Buffer.alloc(1), 0, 1, null);
  await cbRead('fs.read(fd, cb) from the fd position', own);
  fs.closeSync(own);
  await cbRead('fs.read(fd, buffer, { offset, length, position }, cb)', fd, Buffer.alloc(6, 46), { offset: 1, length: 4, position: 5 });
  await cbRead('fs.read(fd, buffer, offset, length, position, cb)', fd, Buffer.alloc(6, 46), 3, 3, 0);
  let b = Buffer.alloc(6, 46);
  show('fs.readSync(fd, buffer, { offset, length, position })', fs.readSync(fd, b, { offset: 1, length: 2, position: 3 }), b, b);
  b = Buffer.alloc(4, 46);
  show('fs.readSync(fd, buffer, { position })', fs.readSync(fd, b, { position: 6 }), b, b);
  b = Buffer.alloc(6, 46);
  show('fs.readSync(fd, buffer, offset, length, position)', fs.readSync(fd, b, 2, 3, 0), b, b);
  b = Buffer.alloc(3, 46);
  const p = await util.promisify(fs.read)(fd, { buffer: b, position: 2 });
  console.log('promisify(fs.read)(fd, { buffer })', typeof p === 'object' ? `${p.bytesRead} ${p.buffer === b ? 'same buffer' : 'other buffer'}` : p, text(b));
  fs.closeSync(fd);
  const wfd = fs.openSync(path.join(work, 'w.txt'), 'w+');
  const wb = Buffer.from('xyz');
  const w = await util.promisify(fs.write)(wfd, wb, 0, 3, 0);
  console.log('promisify(fs.write)(fd, buffer)', w.bytesWritten, w.buffer === wb ? 'same buffer' : 'other buffer');
  const ws = await util.promisify(fs.write)(wfd, 'hello', 3);
  console.log('promisify(fs.write)(fd, string)', ws.bytesWritten, ws.buffer);
  const rb = Buffer.alloc(8, 46);
  const r = await util.promisify(fs.read)(wfd, rb, 0, 8, 0);
  console.log('promisify(fs.read)(fd, buffer)', r.bytesRead, r.buffer === rb ? 'same buffer' : 'other buffer', text(rb));
  fs.closeSync(wfd);
  fs.rmSync(work, { recursive: true, force: true });
})();
