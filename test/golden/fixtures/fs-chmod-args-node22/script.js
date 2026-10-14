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

(async () => {
  fs.writeFileSync('f', 'x');
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
  fs.symlinkSync('f', 'link');
  fs.mkdirSync('d');
  fs.chmodSync('d', 0o755);
  await cb('chmod callback missing', (done) => fs.chmod('missing', 0o751, done));
  await cb('chmod callback bad mode', (done) => fs.chmod('f', 'x', done));
  await cb('chmod no callback', () => fs.chmod('f', 0o644));
  await showAsync('promises.chmod missing', () => fs.promises.chmod('missing', 0o644));
  await showAsync('promises.chmod bad mode', () => fs.promises.chmod('f', '9'));
  console.log('promises.chmod.length:', fs.promises.chmod.length);
  const fd = fs.openSync('f', 'r');
  show('fchmodSync bad mode', () => fs.fchmodSync(fd, 'rwx'));
  fs.closeSync(fd);
  show('fchmodSync closed fd', () => fs.fchmodSync(fd, 0o644));
  show('fchmodSync bad fd', () => fs.fchmodSync(-1, 0o644));
  await cb('fchmod callback closed fd', (done) => fs.fchmod(fd, 0o644, done));
  const fh = await fs.promises.open('f', 'r');
  await showAsync('FileHandle.chmod bad mode', () => fh.chmod('z'));
  await fh.close();
  await showAsync('FileHandle.chmod closed', () => fh.chmod(0o644));
  // mkdir without recursive: EEXIST, on every kernel.
  show('mkdirSync new', () => fs.mkdirSync('m'));
  show('mkdirSync again', () => fs.mkdirSync('m'));
  show('mkdirSync over a file', () => fs.mkdirSync('f'));
  show('mkdirSync over a symlink', () => fs.mkdirSync('link'));
  show('mkdirSync recursive: false', () => fs.mkdirSync('m', { recursive: false }));
  show('mkdirSync /', () => fs.mkdirSync('/'));
  show('mkdirSync absolute new', () => fs.mkdirSync(path.join(work, 'abs')));
  await cb('mkdir callback EEXIST', (done) => fs.mkdir('m', done));
  await cb('mkdir callback new', (done) => fs.mkdir('m2', done));
  await showAsync('promises.mkdir EEXIST', () => fs.promises.mkdir('m'));
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
