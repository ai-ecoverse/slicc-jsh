const { spawnSync } = require('child_process');
const { realpathSync } = require('fs');
const dir = realpathSync(__dirname);
const files = ['cjs.js', 'esm.mjs', 'shift.mjs', 'nested.js', 'hashbang.js', 'promise.js', 'required.js', 'later.js', 'caught.js', 'caught.mjs', 'escaping.js', 'return.js'];
for (const file of files) {
  const r = spawnSync(process.execPath, [file], { cwd: __dirname, encoding: 'utf8', argv0: 'node' });
  const shown = (r.stdout + r.stderr).split('\n').filter((line) => !line.startsWith('    at ') || line.includes('(eval at ')).join('\n');
  console.log(`== ${file}: status ${r.status}`);
  process.stdout.write(shown.split(dir).join('DIR').split(__dirname).join('DIR'));
}
