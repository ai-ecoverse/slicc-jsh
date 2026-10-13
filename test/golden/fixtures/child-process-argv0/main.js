const cp = require('child_process');
const show = (label, r) => console.log(label, JSON.stringify(String(r.stdout ?? '').trim()), r.status);
show('spawnSync /bin/sh', cp.spawnSync('/bin/sh', ['-c', 'printf "%s" "$0"']));
show('spawnSync sh', cp.spawnSync('sh', ['-c', 'printf "%s" "$0"']));
show('spawnSync argv0', cp.spawnSync('/bin/sh', ['-c', 'printf "%s" "$0"'], { argv0: 'zork' }));
console.log('execSync $0', JSON.stringify(cp.execSync('printf "%s" "$0"', { encoding: 'utf8' })));
console.log('execFileSync argv0', JSON.stringify(cp.execFileSync('sh', ['-c', 'printf "%s" "$0"'], { argv0: 'zork', encoding: 'utf8' })));
const c = cp.spawn('/bin/sh', ['-c', 'printf "%s" "$0"'], { argv0: 'async-zork' });
console.log('spawnargs', JSON.stringify(c.spawnargs), c.spawnfile);
let o = ''; c.stdout.on('data', (d) => (o += d));
c.on('close', () => {
  console.log('spawn argv0', JSON.stringify(o));
  cp.exec('printf "%s" "$0"', (e, out) => {
    console.log('exec $0', JSON.stringify(out));
    try { cp.spawn('x', { argv0: 5 }); } catch (err) { console.log(err.code, err.message); }
  });
});
