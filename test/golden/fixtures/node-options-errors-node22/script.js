// The second half of node-options-node22 (split so that each fixture's
// children start within the shim's 30 s on the old kernels, #241): Node's
// errors, values that look like options, short options with `=`.
const { spawnSync } = require('child_process');
const run = (nodeOptions, args) => {
  const env = { ...process.env, NODE_OPTIONS: nodeOptions };
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', env, argv0: 'node' });
  console.log(`== NODE_OPTIONS=${JSON.stringify(nodeOptions)} ${args.join(' ')}: status ${r.status}`);
  process.stdout.write(r.stdout);
  process.stdout.write(r.stderr.replace(/\(node:\d+\)/g, '(node:PID)'));
};
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
// A value that looks like an option isn't one (NODE_OPTIONS and the command line).
run('--require --no-warnings', ['show.js']);
run('', ['--require', '--no-warnings', 'show.js']);
run('--title --x', ['show.js']);
run('', ['--import', '--x', 'show.js']);
run('', ['-e', '-1']);
// A short option takes no `=`.
run('-C=foo', ['show.js']);
run('-r=./r1.js', ['show.js']);
run('', ['-r=./r1.js', 'show.js']);
