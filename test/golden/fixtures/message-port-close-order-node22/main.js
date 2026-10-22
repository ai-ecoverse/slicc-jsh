const { spawnSync } = require('child_process');
const names = require('./cases.js');
for (const name of names) {
  const r = spawnSync(process.execPath, ['cases.js', name], { cwd: __dirname, encoding: 'utf8' });
  console.log(`== ${name}: status ${r.status}`);
  process.stdout.write(r.stdout);
  process.stdout.write(r.stderr);
}
