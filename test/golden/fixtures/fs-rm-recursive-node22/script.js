const fs = require('fs');
const os = require('os');
const path = require('path');
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rmr-')));
process.chdir(work);
const rel = (s) => String(s).split(work).join('<work>');
const err = (e) =>
  `THROW ${e.name} ${e.code} errno=${e.errno} syscall=${e.syscall} path=${rel(e.path)} ${JSON.stringify(rel(e.message))}`;
const show = (label, f) => {
  let v;
  try {
    v = f();
    v = v === undefined ? 'undefined' : JSON.stringify(v);
  } catch (e) {
    v = err(e);
  }
  console.log(`${label}: ${v}`);
};
const showAsync = async (label, f) => {
  let v;
  try {
    v = await f();
    v = v === undefined ? 'undefined' : JSON.stringify(v);
  } catch (e) {
    v = err(e);
  }
  console.log(`${label}: ${v}`);
};
const cb = (label, f) =>
  new Promise((resolve) => f((e) => (console.log(`${label}: ${e ? err(e) : 'ok'}`), resolve())));
const tree = (root) => {
  fs.mkdirSync(`${root}/a/b/c`, { recursive: true });
  fs.mkdirSync(`${root}/empty`);
  fs.writeFileSync(`${root}/top.txt`, 't');
  fs.writeFileSync(`${root}/a/one.txt`, '1');
  fs.writeFileSync(`${root}/a/b/c/deep.txt`, 'd');
  fs.symlinkSync('../../keep', `${root}/a/link-dir`);
  fs.symlinkSync('../keep/k.txt', `${root}/link-file`);
  fs.symlinkSync('nowhere', `${root}/dangling`);
};
const left = () => fs.readdirSync('.').sort().join(' ');

(async () => {
  fs.mkdirSync('keep');
  fs.writeFileSync('keep/k.txt', 'k');
  fs.writeFileSync('f', 'x');

  tree('t1');
  show('rmSync tree', () => fs.rmSync('t1', { recursive: true }));
  show('t1 gone', () => fs.existsSync('t1'));
  show('symlink targets kept', () => fs.readdirSync('keep'));
  tree('t2');
  show('rmSync tree force, trailing slash', () => fs.rmSync('t2/', { recursive: true, force: true }));
  tree('t3');
  await showAsync('promises.rm tree', () => fs.promises.rm('t3', { recursive: true }));
  tree('t4');
  await cb('rm callback tree', (done) => fs.rm('t4', { recursive: true }, done));
  tree('t6');
  show('rmSync absolute tree', () => fs.rmSync(path.join(work, 't6'), { recursive: true }));
  fs.mkdirSync('e');
  show('rmSync empty dir recursive', () => fs.rmSync('e', { recursive: true }));
  fs.symlinkSync('keep', 'dirlink');
  show('rmSync symlink to a dir, recursive', () => fs.rmSync('dirlink', { recursive: true }));
  show('keep still there', () => fs.readdirSync('keep'));
  fs.writeFileSync('g', 'x');
  show('rmSync file recursive', () => fs.rmSync('g', { recursive: true }));

  tree('t7');
  show('rmSync dir, no recursive', () => fs.rmSync('t7'));
  await showAsync('promises.rm dir, no recursive', () => fs.promises.rm('t7'));
  await cb('rm callback dir, no recursive', (done) => fs.rm('t7', done));
  show('rmSync dir, recursive false', () => fs.rmSync('t7', { recursive: false, force: true }));
  show('t7 kept', () => fs.existsSync('t7/a/b/c/deep.txt'));
  fs.rmSync('t7', { recursive: true });

  show('rmSync missing', () => fs.rmSync('missing', { recursive: true }));
  show('rmSync missing force', () => fs.rmSync('missing', { recursive: true, force: true }));
  await showAsync('promises.rm missing', () => fs.promises.rm('missing', { recursive: true }));
  await showAsync('promises.rm missing force', () => fs.promises.rm('missing', { recursive: true, force: true }));
  await cb('rm callback missing', (done) => fs.rm('missing', { recursive: true }, done));
  show('rmSync missing/x', () => fs.rmSync('missing/x', { recursive: true }));
  show('rmSync f/x', () => fs.rmSync('f/x', { recursive: true }));
  show('rmSync f/x force', () => fs.rmSync('f/x', { recursive: true, force: true }));
  show('rmSync recursive: 1', () => fs.rmSync('f', { recursive: 1 }));
  show('rmSync force: "yes"', () => fs.rmSync('f', { force: 'yes' }));
  show('rmSync maxRetries: -1', () => fs.rmSync('f', { maxRetries: -1 }));
  show('rmSync retryDelay: 1.5', () => fs.rmSync('f', { retryDelay: 1.5 }));
  show('rmSync options null', () => fs.rmSync('f', null));
  show('rmSync options string', () => fs.rmSync('f', 'x'));
  await showAsync('promises.rm recursive: 1', () => fs.promises.rm('f', { recursive: 1 }));
  try {
    fs.rm('f', { recursive: 1 }, () => console.log('rm callback recursive: 1: called back'));
  } catch (e) {
    console.log(`rm callback recursive: 1: sync ${err(e)}`);
  }
  console.log('left:', left());
  process.chdir(os.tmpdir());
  fs.rmSync(work, { recursive: true });
  console.log('work exists:', fs.existsSync(work));
})();
