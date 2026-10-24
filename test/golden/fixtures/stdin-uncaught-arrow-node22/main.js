const { spawnSync } = require('child_process');
const run = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node', input });
  const shown = r.stderr.split('\n').filter((line) => !line.startsWith('    at ')).join('\n');
  console.log(`== ${JSON.stringify(args)}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status}`);
  process.stdout.write(r.stdout);
  process.stdout.write(shown);
};
const cases = [
  'let a = 1;\nnull.x',
  'throw new TypeError("t")',
  'let a = 1;\n  throw 7',
  'function f() {\n  return g();\n}\nfunction g() { throw new Error("deep") }\nf()',
  'Promise.reject(new Error("rej"))',
  'setTimeout(() => { null.y }, 1)',
  'const e = new Error("own"); e.code = "E_OWN"; throw e',
];
for (const code of cases) {
  run([], code);
  run(['-e', code]);
}
