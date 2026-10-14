// NODE_OPTIONS as Node 22.22.0 reads it: its words (spaces, "…" with
// backslash escapes), its options before the command line's and not in
// execArgv, only the options it allows, Node's errors. Each run is a child.
const { spawnSync } = require('child_process');
const run = (nodeOptions, args) => {
  const env = { ...process.env, NODE_OPTIONS: nodeOptions };
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', env, argv0: 'node' });
  console.log(`== NODE_OPTIONS=${JSON.stringify(nodeOptions)} ${args.join(' ')}: status ${r.status}`);
  process.stdout.write(r.stdout);
  process.stdout.write(r.stderr.replace(/\(node:\d+\)/g, '(node:PID)'));
};
run('--no-deprecation', ['show.js']);
run('--no-warnings', ['show.js']);
run('--no-warnings   --title=from-env', ['show.js']);
run('--title=env', ['--title=cli', 'show.js']);
run('--stack-trace-limit=3', ['show.js']);
run('--stack-trace-limit=3', ['--stack-trace-limit=4', 'show.js']);
run('-r ./r1.js', ['-r', './r2.js', 'show.js']);
run('--require=./r1.js --import ./i1.mjs', ['show.js']);
run('--require "./r q.js"', ['show.js']);
run('-r "./r\\"q.js"', ['show.js']);
run('"--no-deprecation"', ['show.js']);
run('--no-dep"recation"', ['show.js']);
run('--no_deprecation', ['show.js']);
run('--no-warnings=x', ['show.js']);
run('foo --no-deprecation', ['show.js']);
run('--no-deprecation foo', ['show.js']);
run("'--no-deprecation'", ['show.js']);
run('   ', ['show.js']);
run('--input-type=module', ['-e', 'console.log(typeof require)']);
run('--max-http-header-size=100 --dns-result-order=ipv4first', ['show.js']);
run('--eval 1', ['show.js']);
run('-e 1', ['show.js']);
run('--bogus', ['show.js']);
run('--bogus', ['--version']);
run('--', ['show.js']);
run('--expose-internals', ['show.js']);
run('"--no-deprecation', ['show.js']);
run('"a\\', ['show.js']);
run('--require', ['show.js']);
run('--require=', ['show.js']);
run('-r', ['show.js']);
run('--title', ['show.js']);
run('--input-type=bad', ['show.js']);
run('--stack-trace-limit=abc', ['show.js']);
run('--bogus', ['--bad-cli-option', 'show.js']);
