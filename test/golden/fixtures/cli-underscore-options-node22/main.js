const { spawnSync } = require('child_process');
const { rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const pattern = join(tmpdir(), 'jsh-golden-underscore-${pid}.log');
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
const show = 'console.log(JSON.stringify(process.execArgv))';
run(['--trace_event_categories', 'a', '--trace_event_file_pattern', pattern, 'show.js']);
run([`--trace_event_file_pattern=${pattern}`, '--trace_event_categories=b,a', 'show.js']);
run(['--trace_events_enabled', '--trace-event_file-pattern', pattern, 'show.js']);
run(['--trace_event_categories', 'a', '--trace_event_file_pattern', pattern, '-e', "console.log(require('trace_events').getEnabledCategories())"]);
run(['--trace_event_categories', '-e', '1']);
run(['--trace_event_categories=', '-e', '1']);
run(['--no-trace_event_categories', '-e', '1']);
run(['--no_trace_events_enabled', '-e', '1']);
run(['--stack_trace_limit=5', '-e', `console.log(Error.stackTraceLimit); ${show}`]);
run(['--stack_trace-limit=x', '-e', '1']);
run(['--input_type=module', '-e', `console.log(typeof require); ${show}`]);
run(['--input_type', 'module', '-e', 'console.log(typeof require)']);
run(['--input_type', '-e', '1']);
run(['--input_type=', '-e', '1']);
run(['--input_type=module_x', '-e', '1']);
run(['--no-input_type', '-e', '1']);
run(['--no_input_type', '-e', '1']);
run(['--no_warnings', '-e', `process.emitWarning('w'); ${show}`]);
run(['--no-trace_warnings', '--trace_warnings', '-e', show]);
run(['--preserve_symlinks', '--preserve_symlinks_main', '--enable_source_maps', '-e', `console.log(process.sourceMapsEnabled); ${show}`]);
run(['--expose_internals', '-e', "console.log(typeof require('internal/options'))"]);
run(['--report_directory=/tmp/a_b', '--report_filename', 'r_1.json', '-e', 'console.log(process.report.directory, process.report.filename)']);
run(['--title=a_b', '-e', 'console.log(process.title)']);
run(['--title', '-a_b', '-e', '1']);
run(['--disable_warning=ExperimentalWarning', '-e', show]);
run(['--require', './pre_load.js', '-e', show]);
run(['--require=./pre_load.js', '-e', show]);
run(['--title=-a_b', '-e', 'console.log(process.title)']);
run(['--title_=a', '-e', '1']);
run(['--_no-warnings', '-e', '1']);
run(['-_e', '1']);
run(['--foo_bar', '-e', '1']);
run(['--require_', './pre_load.js', '-e', '1']);
run(['-e', `process.emitWarning('w'); console.log(require('trace_events').getEnabledCategories(), Error.stackTraceLimit); ${show}`], `--trace_event_categories q --trace_event_file_pattern ${pattern} --no_warnings --stack_trace_limit=3`);
run(['-e', 'console.log(Error.stackTraceLimit)'], '--stack_trace_limit=3');
run(['-e', 'console.log(typeof require)'], '--input_type=module');
run(['-e', '1'], '--input_type');
run(['-e', '1'], '--input_type=');
run(['-e', '1'], '--no-input_type');
run(['-e', '1'], '--_no-warnings');
run(['-e', '1'], '-_r ./pre_load.js');
run(['-e', '1'], '--foo_bar');
run(['-e', '1'], '--eval_=1');
const { Worker } = require('worker_threads');
const workers = [
  { execArgv: ['--stack_trace_limit=3'] },
  { execArgv: ['--title_x'] },
  { execArgv: ['--title', 'x'] },
  { execArgv: ['--trace_event_categories', 'x'] },
  { execArgv: ['--_no-warnings'] },
  { execArgv: ['--no_warnings'] },
  { execArgv: ['--input_type=module'] },
  { env: { NODE_OPTIONS: '--title_x' } },
  { env: { NODE_OPTIONS: '--trace_event_categories x' } },
  { env: { NODE_OPTIONS: '--no_warnings' } },
];
(async () => {
  for (const options of workers) {
    const label = JSON.stringify(options);
    try {
      const w = new Worker("import('worker_threads').then((m) => m.parentPort.postMessage(process.execArgv))", { eval: true, ...options });
      const execArgv = await new Promise((resolve) => w.once('message', resolve));
      await new Promise((resolve) => w.once('exit', resolve));
      console.log('worker', label, 'ok', JSON.stringify(execArgv));
    } catch (e) {
      console.log('worker', label, e.code, e.message);
    }
  }
})();
