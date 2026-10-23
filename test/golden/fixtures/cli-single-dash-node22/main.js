const { spawnSync } = require('child_process');
const run = (args) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node' });
  console.log(`== ${args.join(' ')}: status ${r.status}`);
  process.stdout.write(r.stdout);
  process.stdout.write(r.stderr);
};
run(['-econsole.log(1)']);
run(['-pconsole.log(1)']);
run(['-rfs', '-e', '1']);
run(['-ifoo']);
run(['-cfoo']);
run(['-e1']);
run(['-stack-trace-limit=5', '-e', 'console.log(Error.stackTraceLimit, process.execArgv)']);
run(['-stack_trace_limit=6', '-e', 'console.log(Error.stackTraceLimit)']);
run(['-max-old-space-size=100', '-e', 'console.log(2)']);
run(['-foo-bar', '-e', '1']);
run(['-no-warnings', '-e', '1']);
run(['-title=x', '-e', 'console.log(process.title)']);
run(['-input-type=module', '-e', 'console.log(typeof require)']);
run(['-pe', '1+1']);
run(['-pe', 'process.execArgv', 'x']);
run(['-pe', '-1']);
run(['-ep', '1+2']);
run(['-pe']);
run(['-pe1']);
run(['-e', 'console.log(4)', '-pconsole.log(5)']);
run(['-stack-trace-limit=x', '-e', '1']);
run(['-stack-trace-limit', '-e', '1']);
run(['-max-old-space-size=-5', '-e', 'console.log(6)']);
const runEnv = (nodeOptions, args) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node', env: { ...process.env, NODE_OPTIONS: nodeOptions } });
  console.log(`== NODE_OPTIONS=${nodeOptions} ${args.join(' ')}: status ${r.status}`);
  process.stdout.write(r.stdout);
  process.stdout.write(r.stderr);
};
runEnv('-stack-trace-limit=5', ['-e', 'console.log(Error.stackTraceLimit)']);
runEnv('-max-old-space-size=100', ['-e', 'console.log(7)']);
const { Worker } = require('worker_threads');
for (const flag of ['-stack-trace-limit=4', '-max-old-space-size=4']) {
  try {
    new Worker('1', { eval: true, execArgv: [flag] });
    console.log('worker', flag, 'started');
  } catch (e) {
    console.log('worker', flag, e.code, e.message);
  }
}
