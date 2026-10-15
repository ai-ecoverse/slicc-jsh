const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dir-')));
const dir = path.join(work, 'adir');
fs.mkdirSync(dir);
fs.mkdirSync(path.join(work, 'bin', 'onlydir'), { recursive: true });
const rel = (s) => String(s).split(work).join('<work>');
const r = cp.spawnSync(dir, ['x']);
console.log('spawnSync dir:', r.error && rel(JSON.stringify([r.error.code, r.error.errno, r.error.syscall, r.error.path, r.error.spawnargs])), r.status, r.pid);
try {
  cp.execFileSync(dir);
} catch (e) {
  console.log('execFileSync dir:', e.code, e.errno, rel(e.message));
}
const p = cp.spawnSync('onlydir', { env: { ...process.env, PATH: path.join(work, 'bin') } });
console.log('PATH with only a directory:', p.error && p.error.code);
const before = process.ppid;
process.ppid = 12345;
console.log('ppid after an assignment unchanged:', process.ppid === before, typeof process.ppid);
const strict = cp.spawnSync(process.execPath, ['--input-type=module', '-e', "const p = process.ppid; try { process.ppid = 5; console.log('no throw', process.ppid === p); } catch (e) { console.log('threw', e.message); }"], { encoding: 'utf8' });
console.log('in a module:', strict.stdout.trim(), strict.stderr.trim());
const c = cp.spawn(dir);
c.on('error', (e) => console.log('spawn dir error:', e.code, e.errno, rel(e.message), c.pid));
c.on('close', (code) => {
  console.log('close', code);
  fs.rmSync(work, { recursive: true, force: true });
});
