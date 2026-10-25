const { spawnSync } = require('child_process');
const run = (args) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node' });
  const shown = r.stderr.split('\n').filter((line) => !line.startsWith('    at ')).join('\n').replaceAll(__dirname, 'DIR');
  console.log(`== ${JSON.stringify(args)}: status ${r.status}`);
  process.stdout.write(r.stdout.replaceAll(__dirname, 'DIR'));
  process.stdout.write(shown);
};
for (const file of ['top.js', 'fn.js', 'timer.js', 'req.js', 'caught.js']) run([file]);
