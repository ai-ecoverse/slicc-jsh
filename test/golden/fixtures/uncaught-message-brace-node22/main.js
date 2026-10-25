const { spawnSync } = require('child_process');
const shownStderr = (stderr) => {
  const out = [];
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('    at ')) {
      out.push(line);
      continue;
    }
    const opens = line.endsWith(' {');
    if (out.at(-1)?.startsWith('    at <frames>')) out[out.length - 1] = `    at <frames>${opens ? ' {' : ''}`;
    else out.push(`    at <frames>${opens ? ' {' : ''}`);
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
  'throw new Error("a {\\n  b")',
  'const e = new Error("a {\\n  b"); e.code = "E1"; throw e',
  'JSON.parse(`{\\n  "a": 1,\\n  "b": }`)',
  'throw new TypeError("bad { a: 1,\\n  b: 2 }")',
  'const e = new Error("one line { a: 1 }"); e.code = "E2"; throw e',
];
for (const code of cases) {
  run(['-e', code]);
  run([], code);
}
run(['cjs.js']);
