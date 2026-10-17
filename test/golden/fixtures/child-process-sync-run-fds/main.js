const cp = require('child_process');
const fs = require('fs');

const out = 'w-srf-out.txt';
const mark = 'w-srf-mark.txt';
// a b c d e f, alternating stdout / stderr
const alt = 'const fs = require("fs"); for (const [fd, s] of [[1, "a"], [2, "b"], [1, "c"], [2, "d"], [1, "e"], [2, "f"]]) fs.writeSync(fd, s + "\\n");';

// To one file fd: in the child's write order.
let fd = fs.openSync(out, 'w');
let r = cp.spawnSync('node', ['-e', alt], { stdio: ['ignore', fd, fd] });
fs.closeSync(fd);
console.log('file fd for both', r.status, JSON.stringify(r.output), JSON.stringify(fs.readFileSync(out, 'utf8')));

// execFileSync with both on one file fd
fd = fs.openSync(out, 'w');
console.log('execFileSync both to file', JSON.stringify(cp.execFileSync('node', ['-e', alt], { stdio: ['ignore', fd, fd] })));
fs.closeSync(fd);
console.log('  file', JSON.stringify(fs.readFileSync(out, 'utf8')));

// To the program's own stdout: stderr on fd 1 too.
console.log('[stdout for both]');
r = cp.spawnSync('node', ['-e', alt], { stdio: ['ignore', 'inherit', 1] });
console.log('[/stdout for both]', r.status, JSON.stringify(r.output));

// stdout on the program's stderr, stderr captured
r = cp.spawnSync('node', ['-e', 'console.log("o to fd 2"); console.error("e piped")'], { stdio: ['ignore', 2, 'pipe'], encoding: 'utf8' });
console.log('stdout to fd 2', r.status, JSON.stringify(r.output));

// execSync, 2>&1 done by the program's fds
console.log('[execSync both to stdout]');
cp.execSync('printf "1\\n"; printf "2\\n" >&2; printf "3\\n"', { stdio: ['ignore', 1, 1] });
console.log('[/execSync both to stdout]');

// A grandchild still writing after the child is killed gets EPIPE: the pipe
// is shut once the child is gone (no orphaned writer). The kill is the
// maxBuffer one, which the grandchild's own output triggers, so the child is
// never killed before the grandchild exists, however slowly they start; a
// timeout kill could come first on a loaded runner (#353).
const pidFile = 'w-srf-bg.pid';
fs.rmSync(mark, { force: true });
const gc = `process.on("SIGPIPE", () => {}); const fs = require("fs"); const t = setInterval(() => { try { fs.writeSync(1, "x\\\\n"); } catch (e) { fs.writeFileSync("${mark}", e.code); process.exit(0); } }, 5); setTimeout(() => { fs.writeFileSync("${mark}", "never"); process.exit(0); }, 6000);`;
r = cp.spawnSync('/bin/sh', ['-c', `node -e '${gc}' & wait`], { maxBuffer: 16 });
console.log('maxBuffer kill with a writing grandchild', r.error && r.error.code, r.signal);

const waitFor = (file, then) => (fs.existsSync(file) ? then() : setTimeout(() => waitFor(file, then), 20));
waitFor(mark, () => {
  console.log('grandchild', fs.readFileSync(mark, 'utf8'));

  // A background process holding the captured stdout keeps execSync waiting,
  // as in Node; redirected away, it doesn't (it is still running when
  // execSync returns, however long that took).
  let t0 = Date.now();
  const held = cp.execSync('node -e "setTimeout(() => {}, 2000)" & echo hi', { encoding: 'utf8' });
  console.log('background holds the pipe', JSON.stringify(held), Date.now() - t0 >= 1800);
  fs.rmSync(pidFile, { force: true });
  const free = cp.execSync(`node -e "setTimeout(() => {}, 60000)" >/dev/null 2>&1 & echo $! > ${pidFile}; echo hi`, { encoding: 'utf8' });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  let running = false;
  try { process.kill(pid, 0); running = true; process.kill(pid, 'SIGKILL'); } catch {}
  console.log('background redirected', JSON.stringify(free), running);

  fs.rmSync(out, { force: true });
  fs.rmSync(mark, { force: true });
  fs.rmSync(pidFile, { force: true });
});
