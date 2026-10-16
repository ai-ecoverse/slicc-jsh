const cp = require('child_process'); const fs = require('fs');
const T = '/tmp/m22b'; fs.mkdirSync(T, { recursive: true });
const rd = (p) => JSON.stringify(fs.readFileSync(p, 'utf8'));
(async () => {
  // async spawn to a fd, closing the fd right after spawn
  let fd = fs.openSync(`${T}/a.txt`, 'w');
  let c = cp.spawn('sh', ['-c', 'sleep 0.2; echo async-out; echo async-err >&2'], { stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  await new Promise((r) => c.on('close', (code) => { console.log('async close', code); r(); }));
  console.log('async to fd closed right after spawn', rd(`${T}/a.txt`).split('\\n').sort().join('|'));
  // stdin from an fd, async
  fs.writeFileSync(`${T}/in.txt`, 'aa\nbb\n'); fd = fs.openSync(`${T}/in.txt`, 'r');
  c = cp.spawn('cat', [], { stdio: [fd, 'pipe', 'inherit'] }); let o = ''; c.stdout.on('data', (d) => (o += d));
  await new Promise((r) => c.on('close', r)); fs.closeSync(fd); console.log('async stdin fd', JSON.stringify(o));
  // stream objects
  c = cp.spawn('sh', ['-c', 'echo via-process-stdout'], { stdio: [process.stdin, process.stdout, process.stderr] });
  await new Promise((r) => c.on('close', (code) => { console.log('stream objects close', code); r(); }));
  // spawnfile / spawnargs right after spawn and exec
  c = cp.spawn('echo', ['a', 'b']); console.log('spawn spawnfile', c.spawnfile, JSON.stringify(c.spawnargs)); await new Promise((r) => c.on('close', r));
  c = cp.exec('echo x'); console.log('exec spawnfile', c.spawnfile, JSON.stringify(c.spawnargs)); await new Promise((r) => c.on('close', r));
  c = cp.execFile('printf', ['%s', 'y']); console.log('execFile spawnfile', c.spawnfile, JSON.stringify(c.spawnargs)); await new Promise((r) => c.on('close', r));
  c = cp.spawn('echo hi', { shell: '/bin/bash' }); console.log('custom shell spawnfile', c.spawnfile, JSON.stringify(c.spawnargs)); await new Promise((r) => c.on('close', r));
  c = cp.spawn('nope-zz'); c.on('error', () => {}); console.log('missing spawnfile', c.spawnfile, JSON.stringify(c.spawnargs));
  // same fd for stdout and stderr in spawnSync: ordering (kernel #432 known)
  fd = fs.openSync(`${T}/both.txt`, 'w'); cp.spawnSync('sh', ['-c', 'echo o1; echo e1 >&2; echo o2'], { stdio: ['ignore', fd, fd] }); fs.closeSync(fd);
  console.log('spawnSync same fd (content, sorted)', rd(`${T}/both.txt`).split('\\n').sort().join('|'));
  // async 'exit 143' (the 128+n guess)
  c = cp.spawn('sh', ['-c', 'exit 143']); await new Promise((r) => c.on('exit', (code, sig) => { console.log('async exit 143 ->', code, sig); r(); }));
})();
