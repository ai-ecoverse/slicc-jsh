const cp = require('child_process');
const t = (l, f) => { try { console.log(l, JSON.stringify(f())); } catch (e) { console.log(l, 'ERR', e.code); } };
const out = (c) => new Promise((r) => { let b = ''; c.stdout.on('data', (d) => (b += d)); c.on('close', () => r(b.trim())); });
(async () => {
  console.log('spawn sh $0', await out(cp.spawn('/bin/sh', ['-c', 'echo $0'])));
  console.log('spawn sh argv0 zork', await out(cp.spawn('/bin/sh', ['-c', 'echo $0'], { argv0: 'zork' })));
  console.log('spawn sh via PATH', await out(cp.spawn('sh', ['-c', 'echo $0'])));
  console.log('spawn node argv0', await out(cp.spawn(process.execPath, ['-p', 'process.argv0'], { argv0: 'zork-node' })));
  console.log('spawn node argv[0] default ends with node', (await out(cp.spawn(process.execPath, ['-p', 'process.argv0']))).endsWith('node'));
  t('spawnSync sh argv0', () => cp.spawnSync('/bin/sh', ['-c', 'echo $0'], { argv0: 'zork-sync', encoding: 'utf8' }).stdout.trim());
  t('execFileSync sh argv0', () => cp.execFileSync('/bin/sh', ['-c', 'echo $0'], { argv0: 'zork-efs', encoding: 'utf8' }).trim());
  await new Promise((r) => cp.execFile('/bin/sh', ['-c', 'echo $0'], { argv0: 'zork-ef' }, (e, o) => { console.log('execFile sh argv0', o.trim()); r(); }));
  await new Promise((r) => cp.exec('echo $0', { argv0: 'zork-exec' }, (e, o) => { console.log('exec $0', o.trim()); r(); }));
  t('argv0 number', () => cp.spawn('/bin/sh', ['-c', 'true'], { argv0: 5 }).pid);
  t('execFile argv0 number', () => cp.execFile('/bin/sh', ['-c', 'true'], { argv0: 5 }) && 'accepted');
})();
