const { spawnSync } = require('child_process');
const { realpathSync } = require('fs');
const dir = realpathSync(__dirname);
const run = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node', input });
  console.log(`== ${JSON.stringify(args)}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status}`);
  console.log(JSON.stringify(r.stderr.split(dir).join('DIR').split(__dirname).join('DIR')));
};
const cases = [
  'queueMicrotask(() => { throw {q: 1} })',
  'queueMicrotask(() => { throw "qs" })',
  'queueMicrotask(() => { throw 5n })',
  'setTimeout(() => queueMicrotask(() => { throw {t: 1} }))',
  'setTimeout(() => queueMicrotask(() => { throw null }))',
  'queueMicrotask(() => { throw {get stack() { throw 1 }} })',
  'queueMicrotask(() => { throw {get stack() { throw 1 }, name: "N", message: "m"} })',
  'throw {get stack() { throw 1 }}',
  'throw {get stack() { throw 1 }, toString() { return "custom" }}',
  'throw {get stack() { throw 1 }, name: "N", message: "m"}',
  'throw Object.create(null, {stack: {get() { throw 1 }}})',
  'throw {get stack() { throw 1 }, name: {toString() { throw 4 }}, message: "m"}',
  'setTimeout(() => { throw {get stack() { return null.g }} })',
  'const e = new Error("x"); Object.defineProperty(e, "stack", { get() { return null.s } }); throw e',
  'setTimeout(() => { const e = new TypeError("t"); Object.defineProperty(e, "stack", { get() { return null.s } }); throw e })',
];
for (const code of cases) {
  run(['-e', code]);
  run([], code);
}
for (const file of ['qm.js', 'qmp.js', 'qm.mjs', 'err.js']) run([file]);
