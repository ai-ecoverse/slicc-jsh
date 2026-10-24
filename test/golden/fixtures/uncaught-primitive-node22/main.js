const { spawnSync } = require('child_process');
const run = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node', input });
  console.log(`== ${JSON.stringify(args)}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status}`);
  process.stdout.write(r.stdout);
  process.stdout.write(r.stderr);
};
const cases = [
  'throw "s"',
  'throw "two words"',
  'throw 1n',
  'throw -12345678901234567890n',
  'throw Symbol("q")',
  'throw null',
  'throw undefined',
  'throw true',
  'throw 1.5',
  'throw -0',
  'let x = 1;\n  throw "t2"',
  'setTimeout(() => { throw "late" })',
  'setTimeout(() => { throw 3n })',
];
for (const code of cases) run(['-e', code]);
run([], 'throw "from stdin"');
run([], 'let y = 1;\nthrow 4n');
