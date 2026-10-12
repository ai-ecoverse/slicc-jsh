const cp = require('child_process');
const fs = require('fs');

const out = 'w-fd-out.txt';
const inp = 'w-fd-in.txt';
const big = 'process.stdout.write("x".repeat(3000000)); process.stdout.write("\\ntail\\n"); process.stderr.write("err\\n")';
const tail = (f) => {
  const t = fs.readFileSync(f, 'utf8');
  return [t.length, JSON.stringify(t.slice(0, 6)), JSON.stringify(t.slice(-16))];
};

// spawnSync: stdout and stderr to a file fd (3 MB: no maxBuffer, as in Node)
let fd = fs.openSync(out, 'w');
fs.writeSync(fd, 'head\n');
let r = cp.spawnSync('node', ['-e', big], { stdio: ['ignore', fd, fd] });
fs.writeSync(fd, 'after\n');
fs.closeSync(fd);
console.log('spawnSync fd out', r.status, r.error && r.error.code, JSON.stringify(r.output), ...tail(out));

// execFileSync to a file fd
fd = fs.openSync(out, 'w');
console.log('execFileSync fd out', JSON.stringify(cp.execFileSync('node', ['-e', 'console.log("to file")'], { stdio: ['ignore', fd, 'pipe'] })));
fs.closeSync(fd);
console.log('  file', JSON.stringify(fs.readFileSync(out, 'utf8')));

// append-mode fd
fs.writeFileSync(out, 'first\n');
fd = fs.openSync(out, 'a');
cp.spawnSync('node', ['-e', 'console.log("appended")'], { stdio: ['ignore', fd, 'inherit'] });
fs.closeSync(fd);
console.log('append fd', JSON.stringify(fs.readFileSync(out, 'utf8')));

// stdin from a file fd, from its position on
fs.writeFileSync(inp, 'skip\nline one\nline two\n');
fd = fs.openSync(inp, 'r');
fs.readSync(fd, Buffer.alloc(5), 0, 5, null);
r = cp.spawnSync('node', ['-e', 'process.stdin.pipe(process.stdout)'], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8' });
fs.closeSync(fd);
console.log('spawnSync fd in', r.status, JSON.stringify(r.stdout));

// stream objects with an fd
r = cp.spawnSync('node', ['-e', 'console.log("via streams")'], { stdio: [process.stdin, process.stdout, process.stderr] });
console.log('spawnSync streams', r.status, JSON.stringify(r.output));

// async spawn: file fds and stream objects
fd = fs.openSync(out, 'w');
fs.writeSync(fd, 'head\n');
const c = cp.spawn('node', ['-e', big], { stdio: ['ignore', fd, fd] });
console.log('spawn props', c.spawnfile, JSON.stringify(c.spawnargs.slice(0, 2)), c.stdin, c.stdout, c.stderr);
c.on('error', (e) => console.log('spawn error', e.code));
c.on('close', (code, sig) => {
  fs.writeSync(fd, 'after\n');
  fs.closeSync(fd);
  console.log('spawn fd out', code, sig, ...tail(out));

  const ifd = fs.openSync(inp, 'r');
  fs.readSync(ifd, Buffer.alloc(5), 0, 5, null);
  const c2 = cp.spawn('node', ['-e', 'process.stdin.pipe(process.stdout)'], { stdio: [ifd, 'pipe', 'inherit'] });
  let o = '';
  c2.stdout.on('data', (d) => (o += d));
  c2.on('close', (code2) => {
    fs.closeSync(ifd);
    console.log('spawn fd in', code2, JSON.stringify(o));
    const s = cp.spawn('node', ['-e', 'console.log("async via streams")'], { stdio: [process.stdin, process.stdout, process.stderr] });
    s.on('close', (code3) => {
      console.log('spawn streams', code3);
      // The parent closes its fds right after spawn(): the child keeps them.
      let ofd = fs.openSync(out, 'w');
      let ifd2 = fs.openSync(inp, 'r');
      const c3 = cp.spawn('node', ['-e', 'process.stdin.pipe(process.stdout)'], { stdio: [ifd2, ofd, 'inherit'] });
      fs.closeSync(ofd);
      fs.closeSync(ifd2);
      c3.on('error', (err) => console.log('closed fds error', err.code));
      c3.on('close', (code6) => {
      console.log('closed fds after spawn', code6, JSON.stringify(fs.readFileSync(out, 'utf8')));
      const e = cp.exec('true');
      console.log('exec props', e.spawnfile, JSON.stringify(e.spawnargs));
      e.on('exit', () => {
        fs.rmSync(out, { force: true });
        fs.rmSync(inp, { force: true });
      });
      });
    });
  });
});
