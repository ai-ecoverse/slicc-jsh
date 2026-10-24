const { spawnSync } = require('child_process');
const run = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node', input });
  const shown = r.stderr.split('\n').filter((line) => !line.startsWith('    at ')).join('\n');
  console.log(`== ${JSON.stringify(args)}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status}`);
  process.stdout.write(r.stdout);
  process.stdout.write(shown);
};
const frames = 'console.log(e.stack.split("\\n").filter((l) => !l.includes("node:") && !l.includes("-wrapper")).join("\\n"))';
const cases = [
  'eval("null.q")',
  'function f() { eval("null.z") }\nf()',
  'eval(`\n\n  throw new Error("e3")`)',
  'eval("function g() { null.g }\\ng()")',
  'let a = 1;\neval(\'null.q2\')',
  '(0, eval)("null.i")',
  'setTimeout(() => eval("null.t"))',
  `try { eval("null.c") } catch (e) { ${frames} }`,
  `let b = 1;\nfunction h() { return eval("function inner() { return null.n }\\ninner()") }\ntry { h() } catch (e) { ${frames} }`,
];
for (const code of cases) {
  run(['-e', code]);
  run([], code);
}
