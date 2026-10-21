const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fsblob-'));
process.chdir(work);
const err = (e) => `${e.name} ${e.code} ${JSON.stringify(e.message)}`;
(async () => {
  fs.writeFileSync('a.bin', Buffer.from([0xe2, 0x82, 0xac, 0x41, 0x00, 0xff]));
  fs.writeFileSync('empty', '');
  const p = fs.openAsBlob('a.bin');
  console.log('promise', p instanceof Promise);
  const b = await p;
  console.log('blob', b instanceof Blob, b.constructor === require('buffer').Blob, b.size, JSON.stringify(b.type));
  console.log('bytes', [...new Uint8Array(await b.arrayBuffer())].join(','));
  console.log('text', JSON.stringify(await b.text()));
  console.log('slice', JSON.stringify(await b.slice(1, 4).text()));
  const typed = await fs.openAsBlob('a.bin', { type: 'text/plain' });
  console.log('type', typed.type);
  console.log('url', (await fs.openAsBlob(pathToFileURL(path.join(work, 'a.bin')))).size);
  console.log('buffer path', (await fs.openAsBlob(Buffer.from('a.bin'))).size);
  console.log('empty', (await fs.openAsBlob('empty')).size);
  const chunks = [];
  for await (const c of (await fs.openAsBlob('a.bin')).stream()) chunks.push(c.length);
  console.log('stream', chunks.reduce((x, y) => x + y, 0));
  const tryIt = async (label, f) => {
    try {
      const r = f();
      console.log(label, 'returned', r instanceof Promise);
      await r.then(
        (v) => console.log(label, 'resolved', v.size),
        (e) => console.log(label, 'rejected', err(e))
      );
    } catch (e) {
      console.log(label, 'THROW', err(e));
    }
  };
  await tryIt('missing', () => fs.openAsBlob('missing'));
  await tryIt('number', () => fs.openAsBlob(1));
  await tryIt('options string', () => fs.openAsBlob('a.bin', 'text/plain'));
  await tryIt('type number', () => fs.openAsBlob('a.bin', { type: 1 }));
  await tryIt('null byte', () => fs.openAsBlob('a\0b'));
  await tryIt('http url', () => fs.openAsBlob(new URL('http://x/a')));
  fs.rmSync(work, { recursive: true });
})();
