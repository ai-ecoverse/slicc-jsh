const { spawnSync } = require('child_process');
const run = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node', input });
  const shown = r.stderr.split('\n').filter((line) => !line.startsWith('    at ')).join('\n').replaceAll(__dirname, 'DIR');
  console.log(`== ${JSON.stringify(args)}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status}`);
  process.stdout.write(r.stdout);
  process.stdout.write(shown);
};
const lines = [
  'const f = (o, e) => e;\nthrow f({ a: 1 }, new Error("x"))',
  'const f = (a, e) => e;\nthrow f("a;}", new Error("y"))',
  'const f = (a, e) => e;\nthrow f(`${1}}`, new Error("t"))',
  'const f = (a, e) => e;\nthrow f(() => { return 1 }, new Error("z"))',
  'const TE = TypeError;\nthrow new TE("x")',
  'var VE = RangeError;\nthrow new VE("v")',
  'const ns = { E: class extends Error {} };\nthrow new ns.E("m")',
  'const o = { g: (e) => e };\nthrow o.g(new TypeError("w"))',
  'const o = {};\nthrow o.f()',
  'throw new Array(-1)',
  'try { throw 1 } catch {} throw new Error("after")',
];
for (const code of lines) {
  run(['-e', code]);
  run([], code);
  run(['-e', `const s = ${JSON.stringify(code)};\neval(s)`]);
}
run(['cjs.js']);
