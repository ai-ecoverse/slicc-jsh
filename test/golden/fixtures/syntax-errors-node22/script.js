// SyntaxError reports as Node prints them (file:line, the line, carets
// under the token, V8's message) for CommonJS and ES modules, against
// host Node; each in a child, frames left out.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synerr-'));
const real = fs.realpathSync(dir);
const cases = [
  ['cjs-token.js', "console.log('never');\nconst x = ;\n"],
  ['cjs-ident.js', "let a = 1;\n  foo bar\n"],
  ['cjs-eof.js', 'function f() {\n  return (1 +\n'],
  ['cjs-string.js', "const s = 'open\n"],
  ['cjs-redeclare.js', 'let a = 1;\nlet a = 2;\n'],
  ['cjs-import.js', "import fs from 'fs';\n"],
  ['esm-token.mjs', "import fs from 'node:fs';\nconsole.log(fs);\nconst x = ;\n"],
  ['esm-ident.mjs', 'export const a = 1;\nfoo bar\n'],
  ['esm-return.mjs', 'return 1;\n'],
  ['esm-number.mjs', 'const n = 1 2;\n'],
  ['esm-eof.mjs', 'if (true) {\n'],
];
for (const [file, src] of cases) {
  const p = path.join(dir, file);
  fs.writeFileSync(p, src);
  const r = spawnSync(process.execPath, [p], { encoding: 'utf8' });
  const err = r.stderr
    .split('\n')
    .filter((l) => !/^\s+at /.test(l))
    .join('\n')
    .split(`file://${real}`).join('file://DIR')
    .split(`file://${dir}`).join('file://DIR')
    .split(real).join('DIR')
    .split(dir).join('DIR');
  console.log(`== ${file} (${r.status})\n${err}`);
}
fs.rmSync(dir, { recursive: true, force: true });
