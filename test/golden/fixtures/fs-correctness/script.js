const fs = require('fs');
const os = require('os');
const path = require('path');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fsc-'));
process.chdir(work);
const show = (label, f) => {
  let v;
  try {
    v = f();
    v = v === undefined ? 'undefined' : JSON.stringify(v);
  } catch (e) {
    v = `THROW ${e.name} ${e.code} ${e.errno} ${e.syscall} ${JSON.stringify(e.message)}`;
  }
  console.log(`${label}: ${v}`);
};
fs.mkdirSync('d/s', { recursive: true });
fs.writeFileSync('d/a.txt', 'a\n');
fs.writeFileSync('d/s/b.txt', 'b\n');

show('rmdirSync non-empty', () => fs.rmdirSync('d'));
show('d/a.txt still there', () => fs.existsSync('d/a.txt'));
show('rmdirSync file', () => fs.rmdirSync('d/a.txt'));
show('rmSync dir without recursive', () => fs.rmSync('d'));
show('d/s/b.txt still there', () => fs.existsSync('d/s/b.txt'));
show('rmSync missing', () => fs.rmSync('missing'));
show('rmSync missing force', () => fs.rmSync('missing', { force: true }));

show('mkdirSync recursive returns first created', () => fs.mkdirSync('m/n/o', { recursive: true }));
show('mkdirSync recursive all exist', () => fs.mkdirSync('m/n', { recursive: true }));
show('readdirSync recursive', () => fs.readdirSync('d', { recursive: true }).sort());
show('readdirSync recursive withFileTypes', () =>
  fs.readdirSync('m', { recursive: true, withFileTypes: true }).map((e) => [e.name, e.parentPath, e.isDirectory()])
);
show('readdirSync buffer', () => fs.readdirSync('d', { encoding: 'buffer' }).map((b) => Buffer.isBuffer(b)));

fs.writeFileSync('bytes.bin', Buffer.from([0, 1, 127, 128, 200, 255]));
show('readFileSync latin1', () => fs.readFileSync('bytes.bin', 'latin1'));
show('readFileSync base64', () => fs.readFileSync('bytes.bin', 'base64'));
show('readFileSync { encoding: hex }', () => fs.readFileSync('bytes.bin', { encoding: 'hex' }));
show('writeFileSync hex', () => (fs.writeFileSync('h.bin', 'ff00', 'hex'), [...fs.readFileSync('h.bin')]));
show('writeFileSync base64', () => (fs.writeFileSync('b.bin', 'AAF/', { encoding: 'base64' }), [...fs.readFileSync('b.bin')]));
show('writeFileSync flag a', () => (fs.writeFileSync('h.bin', 'x', { flag: 'a' }), [...fs.readFileSync('h.bin')]));
show('writeFileSync flag wx', () => fs.writeFileSync('h.bin', 'x', { flag: 'wx' }));
show('appendFileSync latin1', () => (fs.appendFileSync('h.bin', 'é', 'latin1'), [...fs.readFileSync('h.bin')]));

show('writeFileSync(fd)', () => {
  const fd = fs.openSync('fd.txt', 'w');
  fs.writeFileSync(fd, 'one ');
  fs.writeFileSync(fd, 'two');
  fs.closeSync(fd);
  return fs.readFileSync('fd.txt', 'utf8');
});
show('readFileSync(fd) from position', () => {
  const fd = fs.openSync('fd.txt', 'r');
  const b = Buffer.alloc(4);
  fs.readSync(fd, b, 0, 4, null);
  const rest = fs.readFileSync(fd, 'utf8');
  fs.closeSync(fd);
  return rest;
});
show('writeFileSync(1)', () => fs.writeFileSync(1, 'to stdout\n'));

show('statSync throwIfNoEntry', () => fs.statSync('missing', { throwIfNoEntry: false }));
show('lstatSync throwIfNoEntry', () => fs.lstatSync('missing', { throwIfNoEntry: false }));
show('statSync instanceof Stats', () => fs.statSync('d') instanceof fs.Stats);
show('Stats', () => {
  const st = fs.statSync('d/a.txt');
  return [st.isFile(), st.isDirectory(), st.size, typeof st.mode, typeof st.blksize, typeof st.blocks, typeof st.nlink];
});
show('Dirent', () => {
  const [e] = fs.readdirSync('d', { withFileTypes: true }).filter((x) => x.name === 'a.txt');
  return [e.name, e.parentPath, e.isFile(), e instanceof fs.Dirent];
});

show('copyFileSync', () => (fs.copyFileSync('d/a.txt', 'c.txt'), fs.readFileSync('c.txt', 'utf8')));
show('copyFileSync EXCL', () => fs.copyFileSync('d/a.txt', 'c.txt', fs.constants.COPYFILE_EXCL));
show('copyFileSync missing', () => fs.copyFileSync('missing', 'c2.txt'));
show('cpSync dir without recursive', () => fs.cpSync('d', 'e'));
show('cpSync recursive', () => (fs.cpSync('d', 'e', { recursive: true }), fs.readdirSync('e', { recursive: true }).sort()));
show('mkdtempSync', () => /^t-[A-Za-z0-9]{6}$/.test(fs.mkdtempSync('t-')));
show('truncateSync', () => (fs.truncateSync('c.txt', 1), fs.readFileSync('c.txt', 'utf8')));
show('truncateSync longer', () => (fs.truncateSync('c.txt', 3), [...fs.readFileSync('c.txt')]));
show('truncateSync missing', () => fs.truncateSync('missing'));
show('chmodSync missing', () => fs.chmodSync('missing', 0o644));
show('opendirSync', () => {
  const dir = fs.opendirSync('d');
  const names = [];
  for (let e = dir.readSync(); e; e = dir.readSync()) names.push(e.name);
  dir.closeSync();
  return names.sort();
});

(async () => {
  const fsp = fs.promises;
  const showA = async (label, f) => {
    let v;
    try {
      v = await f();
      v = v === undefined ? 'undefined' : JSON.stringify(v);
    } catch (e) {
      v = `THROW ${e.name} ${e.code} ${e.syscall} ${JSON.stringify(e.message)}`;
    }
    console.log(`${label}: ${v}`);
  };
  await showA('promises.rm dir without recursive', () => fsp.rm('d'));
  await showA('promises.rmdir non-empty', () => fsp.rmdir('d'));
  await showA('promises.readFile base64', () => fsp.readFile('bytes.bin', 'base64'));
  await showA('promises.writeFile flag a', async () => (await fsp.writeFile('p.txt', 'x'), await fsp.writeFile('p.txt', 'y', { flag: 'a' }), fsp.readFile('p.txt', 'utf8')));
  await showA('promises.mkdir recursive', () => fsp.mkdir('q/r', { recursive: true }));
  await showA('promises.readdir recursive', async () => (await fsp.readdir('q', { recursive: true })).sort());
  await showA('promises.copyFile', async () => (await fsp.copyFile('d/a.txt', 'pc.txt'), fsp.readFile('pc.txt', 'utf8')));
  await showA('promises.mkdtemp', async () => /^u-/.test(await fsp.mkdtemp('u-')));
  await showA('promises.truncate', async () => (await fsp.truncate('pc.txt', 0), fsp.readFile('pc.txt', 'utf8')));
  await showA('FileHandle.readFile', async () => {
    const h = await fsp.open('d/a.txt');
    try {
      return await h.readFile('utf8');
    } finally {
      await h.close();
    }
  });
  await showA('rm callback dir without recursive', () => new Promise((resolve) => fs.rm('d', (err) => resolve(err && err.code))));
  process.chdir(os.tmpdir());
  fs.rmSync(work, { recursive: true, force: true });
  console.log('cleaned', !fs.existsSync(work));
})();
