// Both halves, one after the other, each in a child (so each has its own globalAgent).
const cp = require('child_process');
for (const f of ['client.js', 'raw.js']) {
  const r = cp.spawnSync(process.execPath, [f], { encoding: 'utf8' });
  console.log(`== ${f}: status ${r.status}`);
  process.stdout.write(r.stdout);
  if (r.stderr) console.log('stderr:', r.stderr);
}
