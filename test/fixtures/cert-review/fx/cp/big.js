const { spawn, execFile } = require('child_process');
const c = spawn('head', ['-c', '1048576', '/dev/zero']);
let n = 0; const sizes = new Set();
c.stdout.on('data', (d) => { n += d.length; });
c.on('close', (code) => {
  console.log('spawn 1 MiB got', n, 'code', code);
  const d = spawn('sh', ['-c', 'head -c 4194304 /dev/urandom | od -An -tx1 | head -c 3000000 | wc -c']);
  let o = ''; d.stdout.on('data', (x) => (o += x));
  d.on('close', () => { console.log('pipeline in child', o.trim());
    execFile('head', ['-c', '2000000', '/dev/zero'], (err, so) => console.log('execFile 2 MB default maxBuffer', err && err.code, err && err.message.split('\n')[0], so.length));
  });
});
