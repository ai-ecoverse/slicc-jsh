const { spawnSync } = require('child_process');
const { rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const pattern = join(tmpdir(), 'jsh-golden-trace-${pid}.log');
const run = (args, nodeOptions) => {
  const env = { ...process.env, NODE_OPTIONS: nodeOptions ?? '' };
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', env, argv0: 'node' });
  rmSync(pattern.replace('${pid}', r.pid), { force: true });
  const shown = args.map((a) => a.replace(pattern, 'PATTERN'));
  const opts = nodeOptions === undefined ? '' : `NODE_OPTIONS=${JSON.stringify(nodeOptions.replace(pattern, 'PATTERN'))} `;
  console.log(`== ${opts}${shown.join(' ')}: status ${r.status}`);
  process.stdout.write(r.stdout.replaceAll(pattern, 'PATTERN'));
  process.stdout.write(r.stderr);
};
run(['--trace-event-file-pattern', pattern, 'show.js']);
run(['--trace-event-file-pattern=x-${rotation}.log', 'show.js']);
run(['--trace-event-categories', 'node.perf,v8', '--trace-event-file-pattern', pattern, 'show.js']);
run([`--trace-event-file-pattern=${pattern}`, '--trace-event-categories=b,a,a', 'show.js']);
run(['--trace-event-categories', 'a', '--trace-event-categories', 'c', '--trace-event-file-pattern', pattern, 'show.js']);
run(['--trace-event-categories', '', 'show.js']);
run(['--trace-events-enabled', '--trace-event-file-pattern', pattern, 'show.js']);
run(['--trace-event-categories', 'a', '--trace-events-enabled', '--trace-event-file-pattern', pattern, 'show.js']);
run(['--trace-events-enabled', '--trace-event-categories', 'a', '--trace-event-file-pattern', pattern, 'show.js']);
run([
  '--trace-event-categories', 'b', '--trace-event-file-pattern', pattern, '-e',
  "const t = require('trace_events'); t.createTracing({ categories: ['a'] }).enable(); console.log(t.getEnabledCategories());",
]);
run(['--trace-event-categories', 'b', 'show.js'], `--trace-event-categories a --trace-event-file-pattern ${pattern}`);
run(['show.js'], `--trace-event-categories=a --trace-event-file-pattern=${pattern}`);
run(['show.js'], `--trace-events-enabled --trace-event-file-pattern ${pattern}`);
run(['--trace-event-categories', '-e', '1']);
run(['--trace-event-categories=', '-e', '1']);
run(['--trace-event-file-pattern', '-e', '1']);
run(['--trace-event-file-pattern=', '-e', '1']);
run(['--trace-event-file-pattern']);
run(['--no-trace-event-categories', '-e', '1']);
run(['--no-trace-event-file-pattern=x', '-e', '1']);
run(['--no-trace-events-enabled', '-e', '1']);
run(['--title=', '-e', '1']);
run(['--no-title', '-e', '1']);
run(['-e', '1'], '--trace-event-categories');
run(['-e', '1'], '--trace-event-categories=');
run(['-e', '1'], '--no-trace-event-file-pattern');
run(['-e', '1'], '--no-trace-events-enabled');
run(['-e', '1'], '--no-loader');
