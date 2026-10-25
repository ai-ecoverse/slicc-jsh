const { spawnSync } = require('child_process');
const run = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node', input });
  console.log(`== ${JSON.stringify(args)}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status}`);
  process.stdout.write(r.stdout);
  process.stdout.write(r.stderr.replaceAll(__dirname, 'DIR'));
};
const cases = [
  'const e = new Error("k {\\n j"); e.stack = "custom {\\n  z"; e.code = 2; throw e',
  'const e = new Error("k"); e.stack = "custom"; throw e',
  'const e = new Error("k"); e.stack = ""; throw e',
  'Error.stackTraceLimit = 0;\nconst e = new Error("x");\ne.code = 1;\nthrow e',
  'Error.stackTraceLimit = 0; throw new TypeError("t")',
  'const e = new RangeError("r"); e.stack = "RangeError: r"; e.info = { a: 1, b: [1, 2] }; throw e',
];
for (const code of cases) {
  run(['-e', code]);
  run([], code);
}
run(['cjs.js']);
