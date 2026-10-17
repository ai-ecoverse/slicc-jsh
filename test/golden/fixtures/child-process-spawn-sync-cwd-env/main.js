const cp = require('child_process');
const fs = require('fs');

const mask = (s) => String(s).split(process.cwd()).join('CWD');
const node = (src, opts) => cp.spawnSync('node', ['-e', src], opts);
const show = (label, fn) => {
  let s;
  try {
    s = JSON.stringify(fn(), (k, v) => (Buffer.isBuffer(v) ? `<Buffer ${v.toString('hex')}>` : v));
  } catch (e) {
    s = `THROW ${e.name} ${e.code}: ${e.message}`;
  }
  console.log(`${label}: ${mask(s)}`);
};

fs.rmSync('w-ss', { recursive: true, force: true });
fs.mkdirSync('w-ss/sub', { recursive: true });
fs.writeFileSync('w-ss/file', 'f');

show('cwd relative', () => node('console.log(process.cwd())', { cwd: 'w-ss/sub', encoding: 'utf8' }).stdout);
show('cwd URL', () => node('console.log(process.cwd())', { cwd: new URL(`file://${process.cwd()}/w-ss`), encoding: 'utf8' }).stdout);
show('cwd missing', () => {
  const r = node('', { cwd: 'w-ss/nope' });
  return [Object.keys(r), r.status, r.signal, r.output, r.pid, r.stdout, r.error.message, r.error.code, r.error.errno, r.error.syscall, r.error.path, r.error.spawnargs];
});
show('cwd file', () => {
  const r = node('', { cwd: 'w-ss/file' });
  return [r.status, r.pid, r.error.message, r.error.code, r.error.errno];
});
show('env', () => node('console.log(JSON.stringify([process.env.A, process.env.B, "U" in process.env]))', {
  env: { PATH: process.env.PATH, A: 'a', B: 2, U: undefined },
  encoding: 'utf8',
}).stdout);
show('env inherited', () => {
  process.env.SS_INHERIT = 'yes';
  return node('console.log(process.env.SS_INHERIT)', { encoding: 'utf8' }).stdout;
});
show('args stringified', () => cp.spawnSync('node', ['-e', 'console.log(process.argv.slice(1).join(","))', 1, true, null], { encoding: 'utf8' }).stdout);
show('shell option', () => cp.spawnSync('node', ['-e', '"console.log(1+1)"'], { shell: false, encoding: 'utf8' }).stdout);
show('ENOENT', () => {
  const r = cp.spawnSync('no-such-cmd-ss', ['a', 'b']);
  const e = r.error;
  return [Object.keys(r), Object.keys(e), e instanceof Error, e.message, e.errno, e.code, e.syscall, e.path, e.spawnargs, r.status, r.signal, r.output, r.pid, r.stdout, r.stderr];
});
fs.rmSync('w-ss', { recursive: true, force: true });
