const cp = require('child_process'); const fs = require('fs');
fs.mkdirSync('/tmp/cwdtest/sub', { recursive: true }); fs.writeFileSync('/tmp/cwdtest/afile', 'x'); process.chdir('/tmp/cwdtest');
const e = (x) => x && `${x.code} ${x.errno} ${x.syscall} ${x.path} ${x.message}`;
for (const cwd of ['sub', './sub', '..', '/tmp', 'nope', '/nope/deeper', 'afile', '']) {
  const r = cp.spawnSync('pwd', { cwd }); console.log('spawnSync cwd', JSON.stringify(cwd), r.status, r.stdout && String(r.stdout).trim(), e(r.error));
  try { console.log('execSync cwd', JSON.stringify(cwd), String(cp.execSync('pwd', { cwd })).trim()); } catch (x) { console.log('execSync cwd', JSON.stringify(cwd), 'throws', x.code, x.status, x.syscall); }
}
