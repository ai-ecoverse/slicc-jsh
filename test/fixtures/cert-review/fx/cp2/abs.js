const { execFile, spawn } = require('child_process');
const fs = require('fs');
const t = (n, f) => new Promise((r) => f((err, out) => { console.log(n, err ? `ERR ${err.code} ${err.message.split('\n')[0]}` : JSON.stringify(String(out))); r(); }));
(async () => {
  for (const p of ['/usr/bin/bash', '/bin/bash', '/usr/bin/env']) { try { const st = fs.statSync(p); console.log('stat', p, st.size, (st.mode & 0o777).toString(8)); } catch (e) { console.log('stat', p, e.code); } try { console.log('readFile', p, fs.readFileSync(p).length); } catch (e) { console.log('readFile', p, e.code); } }
  await t("execFile('bash')", (cb) => execFile('bash', ['-c', 'echo via-bash'], cb));
  await t("execFile('/usr/bin/bash')", (cb) => execFile('/usr/bin/bash', ['-c', 'echo via-abs'], cb));
  await t("execFile('/usr/bin/env', ['bash'])", (cb) => execFile('/usr/bin/env', ['bash', '-c', 'echo via-env'], cb));
  await t("spawn('/usr/bin/bash')", (cb) => { const c = spawn('/usr/bin/bash', ['-c', 'echo via-spawn-abs']); let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('error', (e) => cb(e)); c.on('close', () => cb(null, o)); });
  await t("exec shell:/bin/bash", (cb) => require('child_process').exec('echo via-shell-$0', { shell: '/bin/bash' }, cb));
})();
