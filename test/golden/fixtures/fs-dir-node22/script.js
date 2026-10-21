const fs = require('fs');
const os = require('os');
const path = require('path');
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsdir-')));
process.chdir(work);
fs.mkdirSync('d/sub', { recursive: true });
fs.writeFileSync('d/a.txt', 'a');
fs.writeFileSync('d/sub/b.txt', 'b');
const err = (e) => `${e.name} ${e.code} ${JSON.stringify(e.message)}`;
const sync = (label, f) => {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, 'THROW', err(e));
  }
};
const names = (list) => list.map((e) => `${path.relative(work, path.resolve(e.parentPath, e.name))}:${e.isDirectory() ? 'd' : 'f'}`).sort().join(' ');
(async () => {
  const d = fs.opendirSync('d');
  sync('path', () => d.path);
  const seen = [];
  for (let e = d.readSync(); e; e = d.readSync()) seen.push(e);
  sync('readSync all', () => names(seen));
  sync('readSync at end', () => d.readSync());
  d.closeSync();
  sync('readSync closed', () => d.readSync());
  await d.read().then(
    () => console.log('read closed: resolved'),
    (e) => console.log('read closed: rejected', err(e))
  );
  sync('read(cb) closed', () => d.read(() => {}));
  sync('closeSync closed', () => d.closeSync());
  await d.close().then(
    () => console.log('close closed: resolved'),
    (e) => console.log('close closed: rejected', err(e))
  );
  await new Promise((resolve) => d.close((e) => (console.log('close(cb) closed', e && err(e)), resolve())));
  const d2 = fs.opendirSync(Buffer.from('d'), { encoding: 'utf8' });
  sync('Buffer path', () => Buffer.isBuffer(d2.path));
  const first = await d2.read();
  console.log('read() dirent', first instanceof fs.Dirent);
  await new Promise((resolve) =>
    d2.read((e, ent) => {
      console.log('read(cb)', e, ent instanceof fs.Dirent);
      resolve();
    })
  );
  console.log('read() end', await d2.read(), await d2.read());
  await d2.close();
  console.log('close() then', 'done');
  const d3 = fs.opendirSync('d', { recursive: true });
  const all = [];
  for await (const e of d3) all.push(e);
  console.log('for await recursive', names(all));
  sync('after for await', () => d3.readSync());
  const d4 = await fs.promises.opendir('d');
  const it = [];
  for await (const e of d4.entries()) it.push(e);
  console.log('promises.opendir entries()', names(it));
  const d5 = fs.opendirSync('d');
  d5[Symbol.dispose]();
  d5[Symbol.dispose]();
  sync('after dispose', () => d5.readSync());
  const d6 = fs.opendirSync('d');
  await d6[Symbol.asyncDispose]();
  await d6[Symbol.asyncDispose]();
  sync('after asyncDispose', () => d6.readSync());
  await new Promise((resolve) =>
    fs.opendir('d', (e, dir) => {
      console.log('opendir(cb)', e, dir instanceof fs.Dir, dir.path);
      dir.closeSync();
      resolve();
    })
  );
  await new Promise((resolve) =>
    fs.opendir('missing', (e) => {
      console.log('opendir(cb) missing', err(e), e.syscall, e.path);
      resolve();
    })
  );
  await fs.promises.opendir('missing').catch((e) => console.log('promises.opendir missing', err(e)));
  sync('opendirSync file', () => fs.opendirSync('d/a.txt'));
  sync('opendirSync bufferSize 0', () => fs.opendirSync('d', { bufferSize: 0 }));
  sync('opendirSync bufferSize x', () => fs.opendirSync('d', { bufferSize: 'x' }));
  sync('opendirSync bufferSize 1', () => fs.opendirSync('d', { bufferSize: 1 }).closeSync());
  sync('opendirSync number', () => fs.opendirSync(1));
  sync('opendir no cb', () => fs.opendir('d'));
  const d7 = fs.opendirSync('d');
  sync('read bad cb', () => d7.read(1));
  sync('close bad cb', () => d7.close(1));
  d7.closeSync();
  fs.rmSync(work, { recursive: true });
})();
