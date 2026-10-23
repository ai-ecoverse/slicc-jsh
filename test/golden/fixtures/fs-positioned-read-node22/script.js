const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fspr-'));
process.chdir(work);
const MIB = 1024 * 1024;
const size = 33 * MIB + 12345;
const src = Buffer.alloc(size);
let x = 0x9e3779b9;
for (let i = 0; i < size; i++) {
  if ((i & 3) === 0) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
  }
  src[i] = (x >>> ((i & 3) * 8)) & 0xff;
}
fs.writeFileSync('big.bin', src);
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const expect = (buf, at, pos, n) => {
  const want = Buffer.alloc(buf.length, 0xee);
  if (n) src.copy(want, at, pos, pos + n);
  return Buffer.compare(want, buf) === 0 ? 'same' : 'DIFFERENT';
};
const fd = fs.openSync('big.bin', 'r');
const cases = [
  ['zero at 0', 0, 0, 0, 8],
  ['zero at end', size, 0, 0, 8],
  ['zero past end', size + 99, 0, 0, 8],
  ['across 1 MiB', MIB - 3, 7, 0, 7],
  ['across 16 MiB', 16 * MIB - 5, 10, 0, 10],
  ['across 32 MiB at an offset', 32 * MIB - 1, 2 * MIB + 1, 9, 2 * MIB + 20],
  ['16 MiB + 7 from 1', 1, 16 * MIB + 7, 0, 16 * MIB + 7],
  ['17 MiB from 3 into offset 5', 3, 17 * MIB, 5, 17 * MIB + 11],
  ['past end from 3', 3, size, 0, size],
  ['tail past end', size - 10, 100, 4, 104],
  ['at end', size, 100, 0, 100],
  ['past end', size + 5, 100, 0, 100],
];
for (const [label, pos, len, at, cap] of cases) {
  const buf = Buffer.alloc(cap, 0xee);
  const n = fs.readSync(fd, buf, at, len, pos);
  console.log('readSync', label, n, hash(buf), expect(buf, at, pos, n));
}
{
  const buf = Buffer.alloc(3 * MIB, 0xee);
  const n = fs.readSync(fd, buf, { offset: 1, length: 2 * MIB, position: 15 * MIB + 1 });
  console.log('readSync options', n, hash(buf), expect(buf, 1, 15 * MIB + 1, n));
  buf.fill(0xee);
  const m = fs.readSync(fd, buf, 2, MIB + 3, BigInt(16 * MIB - 1));
  console.log('readSync bigint', m, hash(buf), expect(buf, 2, 16 * MIB - 1, m));
}
{
  const backing = Buffer.alloc(4 * MIB, 0xee);
  const view = new Uint8Array(backing.buffer, backing.byteOffset + 1000, 2 * MIB);
  const n = fs.readSync(fd, view, 7, MIB, 16 * MIB - 100);
  const want = Buffer.alloc(4 * MIB, 0xee);
  src.copy(want, 1007, 16 * MIB - 100, 16 * MIB - 100 + n);
  console.log('readSync view', n, hash(backing), Buffer.compare(want, backing) === 0 ? 'same' : 'DIFFERENT');
}
{
  const buf = Buffer.alloc(MIB + 1);
  const parts = [];
  let n;
  fs.readSync(fd, buf, 0, 10, 20);
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) parts.push(Buffer.from(buf.subarray(0, n)));
  console.log('readSync own position', parts.length, Buffer.compare(Buffer.concat(parts), src) === 0 ? 'same' : 'DIFFERENT');
}
for (const chunk of [64 * 1024, MIB - 1, MIB, 16 * MIB, 16 * MIB + 1, 64 * MIB]) {
  const buf = Buffer.alloc(chunk);
  const h = crypto.createHash('sha256');
  let calls = 0;
  for (let pos = 0; ; pos += chunk) {
    const n = fs.readSync(fd, buf, 0, chunk, pos);
    calls++;
    if (n === 0) break;
    h.update(buf.subarray(0, n));
  }
  console.log('chunks', chunk, calls, h.digest('hex').slice(0, 16) === hash(src) ? 'same' : 'DIFFERENT');
}
{
  const bufs = [Buffer.alloc(MIB - 1, 0xee), Buffer.alloc(16 * MIB, 0xee), Buffer.alloc(9, 0xee)];
  const n = fs.readvSync(fd, bufs, 2);
  const got = Buffer.concat(bufs);
  console.log('readvSync', n, hash(got), expect(got, 0, 2, n));
}
fs.closeSync(fd);
(async () => {
  const cb = await new Promise((resolve, reject) => {
    const cfd = fs.openSync('big.bin', 'r');
    const buf = Buffer.alloc(18 * MIB, 0xee);
    fs.read(cfd, buf, 3, 17 * MIB, 16 * MIB - 2, (err, n) => {
      fs.closeSync(cfd);
      if (err) reject(err);
      else resolve(`${n} ${hash(buf)} ${expect(buf, 3, 16 * MIB - 2, n)}`);
    });
  });
  console.log('fs.read', cb);
  const fh = await fs.promises.open('big.bin', 'r');
  let buf = Buffer.alloc(2 * MIB, 0xee);
  let r = await fh.read(buf, 1, 2 * MIB - 1, MIB - 1);
  console.log('FileHandle.read', r.bytesRead, hash(buf), expect(buf, 1, MIB - 1, r.bytesRead));
  buf = Buffer.alloc(64, 0xee);
  r = await fh.read(buf, { offset: 8, length: 56, position: size - 20 });
  console.log('FileHandle.read options', r.bytesRead, hash(buf), expect(buf, 8, size - 20, r.bytesRead));
  buf = Buffer.alloc(64 * MIB, 0xee);
  r = await fh.read(buf, 0, buf.length, 0);
  console.log('FileHandle.read 64 MiB', r.bytesRead, hash(buf), expect(buf, 0, 0, r.bytesRead));
  r = await fh.read(Buffer.alloc(8), 0, 0, 5);
  console.log('FileHandle.read zero', r.bytesRead);
  await fh.close();
  for (const [start, end, highWaterMark] of [[MIB - 7, 16 * MIB + 9, 3 * MIB + 1], [size - 5, undefined, 64 * 1024], [size + 3, undefined, 1024]]) {
    const parts = [];
    for await (const c of fs.createReadStream('big.bin', { start, end, highWaterMark })) parts.push(c);
    const got = Buffer.concat(parts);
    const want = src.subarray(start, end === undefined ? size : end + 1);
    console.log('createReadStream', start, end, got.length, hash(got), Buffer.compare(got, want) === 0 ? 'same' : 'DIFFERENT');
  }
  process.chdir(os.tmpdir());
  fs.rmSync(work, { recursive: true, force: true });
})();
