const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tabbed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kinds-')));
const files = {
  "cjs-2.js": "const o = {};\n\t\to.q.r\n",
  "cjs-3.js": "\tthrow new TypeError(\"c\")\n",
  "cjs-4.js": "function f() {\n\tconst e = new RangeError(\"m\"); e.stack; throw e\n}\nf()\n",
  "cjs-5.js": "setTimeout(() => {\n\tnull.x\n})\n",
  "cjs-7.js": "const x = 1;\n\tthrow Object.assign(new Error(\"x\"), { code: \"E1\" });\n",
  "esm-file-timer.mjs": "export const w = 1;\nsetTimeout(() => {\n\tthrow new TypeError(\"f\")\n});\n",
};
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(tabbed, name), text);
const run = (args, input, cwd = __dirname) => {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', argv0: 'node', input });
  const shown = r.stderr.split('\n').filter((line) => !line.startsWith('    at ')).join('\n').replaceAll(cwd, 'DIR');
  console.log(`== ${JSON.stringify(args)}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status}`);
  process.stdout.write(r.stdout);
  process.stdout.write(shown);
};
const cases = [
  'const s = "undefinedFn()"; eval(s)',
  'const s = "const u = 1; u()"; eval(s)',
  'const o = {};\nconst s = "\\to.f()";\neval(s)',
  'const s = "x; let x = 1"; eval(s)',
  'const s = "new Array(-1)"; eval(s)',
  'const s = "throw new Error(\\"t\\")"; eval(s)',
  'const s = "const e = new Error(\\"n\\"); throw e"; eval(s)',
  'const s = "throw new TypeError(\\"y\\")"; eval(s)',
  'const s = "class E extends Error {}; throw new E(\\"z\\")"; eval(s)',
  'const s = "try { undefinedFn() } catch (e) { e.stack; throw e }"; eval(s)',
  'const s = "const e = new Error(\\"r\\"); e.stack; throw e"; eval(s)',
  'const s = "undefinedFn()";\n(0, eval)(s)',
  'const s = "undefinedFn()";\nsetTimeout(() => eval(s))',
  'const s = "undefinedFn()";\n(async () => { await 1; eval(s) })()',
  'const s = "function g() { return 1n + 1 }\\ng()"; eval(s)',
  'const s = "\\tfunction g() { g() }\\ng()"; eval(s)',
  'const s = "throw new Array(-1)"; eval(s)',
  'const s = "\\tthrow Error(\\"w\\")"; eval(s)',
  'const s = "throw undefinedFn()"; eval(s)',
  'const s = "(async () => { throw new Error(\\"a\\") })()"; eval(s)',
  'const s = "if (!s) throw 1; throw new RangeError(\\"q\\")"; eval(s)',
  'const x = 1;\nthrow Object.assign(new Error("x"), { code: "E1" })',
  'throw new (class Foo extends Error {})("e")',
  'const s = "throw Object.assign(new TypeError(\\"t\\"), { code: 1 })"; eval(s)',
  'const s = "throw Object.assign(new Array(-1), {})"; eval(s)',
  'const s = "throw [1].map(() => new Error(\\"m\\"))[0]"; eval(s)',
  'undefinedFn()',
  '\tthrow new TypeError("t")',
  'const o = {}; o.f()',
  'throw new Error("plain")',
];
for (const code of cases) {
  run(['-e', code]);
  run([], code);
}
for (const file of ['cjs.js', 'cjs-1.js', 'cjs-2.js', 'cjs-3.js', 'cjs-4.js', 'cjs-5.js', 'cjs-6.js', 'cjs-7.js', 'esm.mjs', 'esm-throw.mjs', 'esm-timer.mjs', 'esm-file-timer.mjs', 'vm.js']) {
  if (files[file] === undefined) run([file]);
  else run([file], undefined, tabbed);
}
fs.rmSync(tabbed, { recursive: true, force: true });
