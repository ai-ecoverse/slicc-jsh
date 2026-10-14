const fs = require('fs');
const os = require('os');
const path = require('path');
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chm-')));
process.chdir(work);
const rel = (s) => String(s).split(work).join('<work>');
const err = (e) =>
  `THROW ${e.name} ${e.code} errno=${e.errno} syscall=${e.syscall} path=${rel(e.path)} ${JSON.stringify(rel(e.message))}`;
const show = (label, f) => {
  let v;
  try {
    v = f();
    v = v === undefined ? 'undefined' : JSON.stringify(rel(v));
  } catch (e) {
    v = err(e);
  }
  console.log(`${label}: ${v}`);
};
const showAsync = async (label, f) => {
  let v;
  try {
    v = await f();
    v = v === undefined ? 'undefined' : JSON.stringify(rel(v));
  } catch (e) {
    v = err(e);
  }
  console.log(`${label}: ${v}`);
};
const cb = (label, f) =>
  new Promise((resolve) => {
    try {
      f((e, v) => {
        console.log(`${label}: ${e ? err(e) : v === undefined ? 'undefined' : JSON.stringify(rel(v))}`);
        resolve();
      });
    } catch (e) {
      console.log(`${label}: sync ${err(e)}`);
      resolve();
    }
  });
const perm = (p) => (fs.statSync(p).mode & 0o7777).toString(8);

(async () => {
  fs.writeFileSync('f', 'x');
  show('new file', () => perm('f'));
  show('chmodSync 0o755', () => (fs.chmodSync('f', 0o755), perm('f')));
  show("chmodSync '600'", () => (fs.chmodSync('f', '600'), perm('f')));
  show("chmodSync '0644'", () => (fs.chmodSync('f', '0644'), perm('f')));
  show('chmodSync 0o100711 (type bits dropped)', () => (fs.chmodSync('f', 0o100711), perm('f')));
  show('chmodSync 0', () => (fs.chmodSync('f', 0), perm('f')));
  fs.chmodSync('f', 0o644);
  show("chmodSync '0o755'", () => fs.chmodSync('f', '0o755'));
  show("chmodSync '8'", () => fs.chmodSync('f', '8'));
  show('chmodSync -1', () => fs.chmodSync('f', -1));
  show('chmodSync 1.5', () => fs.chmodSync('f', 1.5));
  show('chmodSync 2**32', () => fs.chmodSync('f', 2 ** 32));
  show('chmodSync no mode', () => fs.chmodSync('f'));
  show('chmodSync {}', () => fs.chmodSync('f', {}));
  show('chmodSync null path', () => fs.chmodSync(null, 0o644));
  show('chmodSync missing', () => fs.chmodSync('missing', 0o644));
  show('chmodSync missing/x', () => fs.chmodSync('missing/x', 0o644));
  show('chmodSync f/x (not a dir)', () => fs.chmodSync('f/x', 0o644));
  show('mode unchanged after errors', () => perm('f'));
  show('chmodSync file: URL', () => (fs.chmodSync(new URL(`file://${work}/f`), 0o700), perm('f')));
  fs.symlinkSync('f', 'link');
  show('chmodSync through a symlink', () => (fs.chmodSync('link', 0o640), perm('f')));
  fs.mkdirSync('d');
  show('new dir', () => perm('d'));
  show('chmodSync dir 0o700', () => (fs.chmodSync('d', 0o700), perm('d')));
  fs.chmodSync('d', 0o755);

  await cb('chmod callback', (done) => fs.chmod('f', 0o751, (e) => done(e, e ? undefined : perm('f'))));
  await cb('chmod callback missing', (done) => fs.chmod('missing', 0o751, done));
  await cb('chmod callback bad mode', (done) => fs.chmod('f', 'x', done));
  await cb('chmod no callback', () => fs.chmod('f', 0o644));
  await showAsync('promises.chmod', async () => (await fs.promises.chmod('f', 0o604), perm('f')));
  await showAsync('promises.chmod missing', () => fs.promises.chmod('missing', 0o644));
  await showAsync('promises.chmod bad mode', () => fs.promises.chmod('f', '9'));
  console.log('promises.chmod.length:', fs.promises.chmod.length);

  const fd = fs.openSync('f', 'r');
  show('fchmodSync', () => (fs.fchmodSync(fd, 0o711), perm('f')));
  show("fchmodSync '640'", () => (fs.fchmodSync(fd, '640'), perm('f')));
  show('fchmodSync bad mode', () => fs.fchmodSync(fd, 'rwx'));
  await cb('fchmod callback', (done) => fs.fchmod(fd, 0o700, (e) => done(e, e ? undefined : perm('f'))));
  fs.closeSync(fd);
  show('fchmodSync closed fd', () => fs.fchmodSync(fd, 0o644));
  show('fchmodSync bad fd', () => fs.fchmodSync(-1, 0o644));
  await cb('fchmod callback closed fd', (done) => fs.fchmod(fd, 0o644, done));
  const fh = await fs.promises.open('f', 'r');
  await showAsync('FileHandle.chmod', async () => (await fh.chmod(0o755), perm('f')));
  await showAsync('FileHandle.chmod bad mode', () => fh.chmod('z'));
  await fh.close();
  await showAsync('FileHandle.chmod closed', () => fh.chmod(0o644));

  // mkdir without recursive: the kernel's EEXIST / ENOENT / ENOTDIR.
  show('mkdirSync new', () => fs.mkdirSync('m'));
  show('mkdirSync again', () => fs.mkdirSync('m'));
  show('mkdirSync over a file', () => fs.mkdirSync('f'));
  show('mkdirSync over a symlink', () => fs.mkdirSync('link'));
  show('mkdirSync missing parent', () => fs.mkdirSync('no/such'));
  show('missing parent not made', () => fs.existsSync('no'));
  show('mkdirSync under a file', () => fs.mkdirSync('f/sub'));
  show('mkdirSync recursive: false', () => fs.mkdirSync('m', { recursive: false }));
  show('mkdirSync /', () => fs.mkdirSync('/'));
  show('mkdirSync absolute new', () => fs.mkdirSync(path.join(work, 'abs')));
  await cb('mkdir callback EEXIST', (done) => fs.mkdir('m', done));
  await cb('mkdir callback ENOENT', (done) => fs.mkdir('no/such', done));
  await cb('mkdir callback new', (done) => fs.mkdir('m2', done));
  await showAsync('promises.mkdir EEXIST', () => fs.promises.mkdir('m'));
  await showAsync('promises.mkdir ENOENT', () => fs.promises.mkdir('no/such'));
  await showAsync('promises.mkdir new', () => fs.promises.mkdir('m3'));
  // recursive: the first directory made, or undefined.
  show('mkdirSync recursive new', () => fs.mkdirSync('r/a/b', { recursive: true }));
  show('mkdirSync recursive part', () => fs.mkdirSync('r/a/c/d', { recursive: true }));
  show('mkdirSync recursive existing', () => fs.mkdirSync('r/a', { recursive: true }));
  show('mkdirSync recursive ./', () => fs.mkdirSync('./q/w', { recursive: true }));
  show('mkdirSync recursive under a file', () => fs.mkdirSync('f/x/y', { recursive: true }));
  await showAsync('promises.mkdir recursive', () => fs.promises.mkdir('s/t', { recursive: true }));
  console.log('listing:', fs.readdirSync('.').sort().join(' '));
  fs.rmSync(work, { recursive: true, force: true });
})();
