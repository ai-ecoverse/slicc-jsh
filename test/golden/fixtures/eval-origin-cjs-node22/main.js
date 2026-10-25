const { spawnSync } = require('child_process');
for (const file of ['top.js', 'fn.js', 'method.js', 'nested.js', 'function.js', 'own.js', 'hashbang.js']) {
  const r = spawnSync(process.execPath, [file], { cwd: __dirname, encoding: 'utf8', argv0: 'node' });
  const lines = r.stdout.split('\n').filter((line) => !line.includes('node:')).join('\n').replaceAll(__dirname, 'DIR');
  console.log(`== ${file}: status ${r.status}`);
  process.stdout.write(lines);
  process.stdout.write(r.stderr.replaceAll(__dirname, 'DIR'));
}
