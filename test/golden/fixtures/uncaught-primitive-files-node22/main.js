const { spawnSync } = require('child_process');
const { realpathSync } = require('fs');
const dir = realpathSync(__dirname);
for (const file of ['string.mjs', 'bigint.mjs', 'symbol.mjs', 'late.mjs', 'bigint.js', 'hashbang.js', 'timer.js', 'null.js']) {
  const r = spawnSync(process.execPath, [file], { cwd: __dirname, encoding: 'utf8', argv0: 'node' });
  console.log(`== ${file}: status ${r.status}`);
  process.stdout.write(r.stderr.split(dir).join('DIR').split(__dirname).join('DIR'));
}
