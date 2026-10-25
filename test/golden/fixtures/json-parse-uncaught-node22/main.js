const { spawnSync } = require('child_process');
const run = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node', input });
  const shown = r.stderr.split('\n').filter((line) => !line.startsWith('    at ')).join('\n').replaceAll(__dirname, 'DIR');
  console.log(`== ${JSON.stringify(args)}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status}`);
  process.stdout.write(r.stdout);
  process.stdout.write(shown);
};
const cases = [
  'JSON.parse("{")',
  'JSON.parse("[1,\\n2,\\n x]")',
  'JSON.parse("")',
  'const t = "{\\"a\\": 1}x";\nJSON.parse(t)',
  'JSON.parse(undefined)',
  'JSON.parse("\\t\\t[1,,]")',
  'JSON.parse("{", (k, v) => v)',
  'JSON.parse("{", () => { throw 1 })',
  'JSON.parse("\\"throw\\" x")',
  'function read(s) {\n  return JSON.parse(s);\n}\nread("[1 2]")',
  'setTimeout(() => JSON.parse("nul"))',
  '(async () => { await 1; JSON.parse("tru") })()',
  'try { JSON.parse("{") } catch (e) { e.stack; throw e }',
  'const s = "JSON.parse(\\"[,]\\")";\neval(s)',
];
for (const code of cases) {
  run(['-e', code]);
  run([], code);
}
for (const file of ['cjs.js', 'esm.mjs']) run([file]);
