'use strict';
// process's read-only members, as Node's (an assignment throws in strict
// code), argv[0] being execPath, and the --report-* command-line options
// (each run as a child) setting process.report.
const { spawnSync } = require('child_process');
const shape = (name) => {
  const d = Object.getOwnPropertyDescriptor(process, name);
  return d ? `writable=${d.writable} configurable=${d.configurable}` : 'none';
};
for (const name of ['argv0', 'pid', 'version', 'versions', 'arch', 'platform', 'release', 'config', 'features', 'ppid', 'execPath', 'title']) {
  let assigned;
  const before = process[name];
  try {
    process[name] = name === 'pid' || name === 'ppid' ? 1 : 'x';
    assigned = 'assigned';
  } catch (e) {
    assigned = `${e.name}: ${e.message}`;
  }
  console.log(name, shape(name), assigned);
  try {
    process[name] = before;
  } catch {
    /* read-only */
  }
}
console.log('argv[0] is execPath', process.argv[0] === process.execPath, 'argv0', process.argv0);
const run = (args) => {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', argv0: 'node' });
  console.log(`== ${args.slice(0, -2).join(' ')}: status ${r.status}`);
  process.stdout.write(r.stdout + r.stderr);
};
const settings =
  'JSON.stringify(Object.fromEntries(Object.keys(process.report).filter((k) => typeof process.report[k] !== "function").map((k) => [k, process.report[k]])))';
run(['-p', settings]);
run(['--report-on-signal', '--report-signal=SIGUSR1', '--report-compact', '--report-dir=/tmp/x', '--report-filename=r.json', '--report-uncaught-exception', '--report-on-fatalerror', '--report-exclude-network', '--report-exclude-env', '-p', settings]);
run(['--report-directory=/tmp/y', '--report-signal', 'SIGUSR1', '-p', settings]);
run(['--report-dir', '-p', settings]);
