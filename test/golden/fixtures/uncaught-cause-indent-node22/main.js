const { spawnSync } = require('child_process');
const FRAME = /^(\s+)(?:at |\.\.\. \d+ lines? matching cause stack trace \.\.\.)/;
const shownStderr = (stderr) => {
  const out = [];
  let open = false;
  for (const line of stderr.split('\n')) {
    const m = FRAME.exec(line);
    if (!m) {
      out.push(line);
      open = false;
      continue;
    }
    const shown = `${m[1]}at <frames>${line.endsWith(' {') ? ' {' : ''}`;
    if (open) out[out.length - 1] = shown;
    else out.push(shown);
    open = true;
  }
  return out.join('\n').replaceAll(__dirname, 'DIR');
};
const run = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node', input });
  console.log(`== ${JSON.stringify(args)}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status}`);
  process.stdout.write(r.stdout);
  process.stdout.write(shownStderr(r.stderr));
};
const cases = [
  'throw new Error("outer", { cause: new Error("inner") })',
  'throw new Error("outer {\\n  x", { cause: new Error("inner {\\n  y") })',
  'throw new Error("outer", { cause: new Error("two\\nlines") })',
  'function f() { throw new Error("o", { cause: new Error("i") }) } f()',
  'const c = new Error("mid", { cause: new TypeError("deep") }); c.code = "C1"; const e = new Error("top", { cause: c }); e.code = "E"; throw e',
  'const c = new RangeError("r"); c.detail = { a: 1 }; throw new Error("o", { cause: c })',
  'throw new Error("o", { cause: "a string" })',
];
for (const code of cases) {
  run(['-e', code]);
  run([], code);
}
run(['cjs.js']);
