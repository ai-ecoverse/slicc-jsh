const cp = require('child_process');
const run = (label, args, env) => {
  const r = cp.spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  const clean = (s) => s.replace(/^.*?: (--\S+ is not allowed)/m, 'node: $1').trim();
  console.log(`${label}: ${r.status} ${JSON.stringify(clean(r.stdout))} ${JSON.stringify(clean(r.stderr))}`);
};
run('--trace-sigint', ['--trace-sigint', '-e', 'console.log(process.execArgv.join(" "))']);
run('NODE_OPTIONS=--eval=1', ['-e', '1'], { NODE_OPTIONS: '--eval=1' });
run('NODE_OPTIONS=--eval', ['-e', '1'], { NODE_OPTIONS: '--eval' });
run('NODE_OPTIONS=--print=1', ['-e', '1'], { NODE_OPTIONS: '--print=1' });
process.versions.node = 'x';
console.log('versions.node after a sloppy assignment:', process.versions.node === process.version.slice(1));
console.log('descriptor:', JSON.stringify(Object.getOwnPropertyDescriptor(process.versions, 'node'), (k, v) => (k === 'value' ? typeof v : v)));
run('a module assigning versions.node', ['--input-type=module', '-e', "try { process.versions.node = 'x'; console.log('assigned'); } catch (e) { console.log(e.name, e.message); }"]);
