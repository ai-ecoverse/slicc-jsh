const { spawnSync } = require('child_process');
const { realpathSync } = require('fs');
const dir = realpathSync(__dirname);
const keep = (line) => !line.startsWith('    at ') || line.includes('(eval at ') || line === '    at eval (<anonymous>)';
const show = (text) => text.split('\n').filter(keep).join('\n').split(dir).join('DIR').split(__dirname).join('DIR');
const run = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node', input });
  console.log(`== ${JSON.stringify(args)}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status}`);
  process.stdout.write(show(r.stdout + r.stderr));
};
const frames = 'console.log(e.stack.split("\\n").filter((l) => !l.includes("node:") && !l.includes("-wrapper")).join("\\n"))';
const cases = [
  'new Function("a", "b", "\\nnull.u")()',
  'const b = "null.nl";\nnew Function(b)()',
  'const AF = (async () => {}).constructor;\nAF("await 0; null.af")()',
  'const GF = function* () {}.constructor;\nGF("null.gf")().next()',
  'Reflect.construct(Function, ["null.r"])()',
  'setTimeout(() => new Function("null.t")())',
  '(0, eval)("null.ui")',
  'function f() {\n  return Function("return eval(\\"null.ne\\")")();\n}\nf()',
  `try { new Function("null.w")() } catch (e) { ${frames} }`,
  `try { (0, eval)("null.i") } catch (e) { ${frames} }`,
  `class A { m() { return Function("null.m")() } }\ntry { new A().m() } catch (e) { ${frames} }`,
  `const o = {};\no.m = function () { return new Function("null.om")() };\ntry { o.m() } catch (e) { ${frames} }`,
  `try { eval("new Function(\\"null.e\\")()") } catch (e) { ${frames} }`,
  `try { new Function("return new Function('null.ff')()")() } catch (e) { ${frames} }`,
  `try { new Function("{") } catch (e) { ${frames} }`,
  `Error.prepareStackTrace = (e, s) => s.filter((c) => !String(c).includes("node:") && !String(c).includes("-wrapper")).join("|");\ntry { (0, eval)("null.p") } catch (e) { console.log(e.stack) }`,
];
for (const code of cases) {
  run(['-e', code]);
  run([], code);
}
for (const file of ['fn.js', 'fn.mjs', 'indirect.js']) run([file]);
