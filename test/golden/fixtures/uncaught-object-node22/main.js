const { spawnSync } = require('child_process');
const { realpathSync } = require('fs');
const dir = realpathSync(__dirname);
const run = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node', input });
  console.log(`== ${JSON.stringify(args)}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status}`);
  console.log(JSON.stringify(r.stderr.split(dir).join('DIR').split(__dirname).join('DIR')));
};
const cases = [
  'throw {a: 1}',
  'setTimeout(() => { throw {late: 1} })',
  'throw Object.create(null)',
  'throw function f() {}',
  'throw {stack: "custom stack"}',
  'throw {message: "m", name: "N"}',
  'let x = 1;\nthrow {b: 2}',
  'function f() {\n  throw {c: 3};\n}\nf()',
  'setImmediate(() => { throw {i: 1} })',
  'process.nextTick(() => { throw {n: 1} })',
  'throw {stack: 5}',
  'setTimeout(() => { throw {stack: "late stack"} })',
  'throw []',
  'throw "s"',
  'setTimeout(() => { throw "late" })',
  'throw Object.freeze({stack: "frozen"})',
];
for (const code of cases) {
  run(['-e', code]);
  run([], code);
}
run(['--input-type=module', '-e', 'throw {m: 1}']);
run(['-p', 'throw {p: 1}']);
for (const file of ['obj.js', 'timer.js', 'stack.js', 'obj.mjs', 'timer.mjs', 'primitive.mjs']) run([file]);
