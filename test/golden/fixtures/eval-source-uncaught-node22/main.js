const { spawnSync } = require('child_process');
const run = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node', input });
  const shown = r.stderr.split('\n').filter((line) => !line.startsWith('    at ')).join('\n');
  console.log(`== ${JSON.stringify(args)}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status}`);
  process.stdout.write(r.stdout);
  process.stdout.write(shown);
};
const cases = [
  'const s = "null.d"; eval(s)',
  'const o = {};\nconst s = "\\n\\to.q.r";\neval(s)',
  'const s = "function g() { null.g }\\ng()";\neval(s)',
  'const s = "null.i";\n(0, eval)(s)',
  'const t = "null.n";\nconst s = "eval(t)";\neval(s)',
  'const s = "null.t";\nsetTimeout(() => eval(s))',
  'const s = "null.r";\n(async () => { await 1; eval(s) })()',
  'const o = {};\nif (process.argv.length > 9) throw new Error("never"); o.a.b',
  'const o = {};\n\t\to.q.r',
  'const o = {};\nfunction f() { try { o.a.b } catch (e) { console.log(1); throw e } }\nf()',
  'const o = {}; try { o.a.b } catch (e) { setTimeout(() => { throw e }) }',
];
for (const code of cases) {
  run(['-e', code]);
  run([], code);
}
for (const file of ['cjs.js', 'esm.mjs', 'vm.js', 'vm-throw.js']) run([file]);
