// #94: exec / shell:true use /bin/sh; ENOENT text = Node; a custom shell is honoured (sequential)
const cp = require('child_process');
const ex = (cmd, o = {}) => new Promise((r) => cp.exec(cmd, o, (err, out, er) => r({ err, out, er })));
const ef = (f, a, o = {}) => new Promise((r) => cp.execFile(f, a, o, (err, out) => r({ err, out })));
(async () => {
  let r = await ex('echo hi; case $0 in *sh) echo is-sh;; esac'); console.log('exec runs a sh:', r.err ? r.err.code : r.out.trim().split('\n')[0]);
  r = await ex('echo $BASH_VERSION | cut -c1', { shell: '/bin/bash' }); console.log('exec shell /bin/bash:', r.err ? r.err.code : r.out.trim().length > 0);
  r = await ex('exit 7'); console.log('exec exit 7:', r.err.code, r.err.killed, r.err.signal, r.err.cmd);
  r = await ex('echo x', { shell: '/no/such/shell' }); console.log('missing shell:', r.err.code, r.err.errno, r.err.syscall, r.err.path, r.err.message);
  r = await ef('echo', ['a b', '$PWD'], { shell: true, cwd: '/' }); console.log('execFile shell:true:', JSON.stringify(r.out));
  await new Promise((res) => { const s = cp.spawn('echo $1-ok', ['ignored'], { shell: true }); let so = ''; s.stdout.on('data', (d) => (so += d)); s.on('close', (c) => { console.log('spawn shell:true:', JSON.stringify(so), c); res(); }); });
  await new Promise((res) => { const s = cp.spawn('echo hi', { shell: true }); console.log('spawnfile', s.spawnfile, JSON.stringify(s.spawnargs)); s.on('close', res); });
  await new Promise((res) => { const bad = cp.spawn('no-such-cmd-xyz'); bad.on('error', (err) => { console.log('spawn ENOENT:', err.code, err.errno, err.syscall, err.path, JSON.stringify(err.spawnargs), err.message); res(); }); });
  r = await ef('no-such-cmd-xyz', []); console.log('execFile ENOENT:', r.err.code, r.err.message);
  r = await ex('no-such-cmd-xyz'); console.log('exec missing cmd:', r.err.code, /not found/.test(r.er));
})();
