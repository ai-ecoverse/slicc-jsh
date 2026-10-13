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
  ['cjs-hashbang.js', '#!/usr/bin/env node\nconsole.log(1);\nconst x = ;\n'],
  ['cjs-with-import-call.js', "import('node:fs').then(() => {}); const a = 1;\nconst x = ;\n"],
  ['esm-hashbang.mjs', '#!/usr/bin/env node\nconsole.log(1);\nconst x = ;\n'],
  ['esm-token.mjs', "import fs from 'node:fs';\nconsole.log(fs);\nconst x = ;\n"],
  ['esm-ident.mjs', 'export const a = 1;\nfoo bar\n'],
  ['esm-return.mjs', 'return 1;\n'],
  ['esm-number.mjs', 'const n = 1 2;\n'],
  ['esm-eof.mjs', 'if (true) {\n'],
  ['esm-reserved-with-import.mjs', "import fs from 'node:fs';\nlet let = 1;\n"],
  ['esm-reserved-static.mjs', 'export { a as b };\nconst a = 1;\nlet static = 2;\n'],
  ['esm-after-default-function.mjs', 'export default function () {}\nawait = 1;\n'],
  ['esm-after-default-class.mjs', 'export default class {}\nconst q = 1 2;\n'],
  ['cjs-regexp.js', 'const r = /a(/;\n'],
  ['esm-regexp.mjs', 'const r = /a(/;\n'],
  ['cjs-regexp-unterminated.js', 'const r = /ab;\n'],
  ['esm-after-import-meta.mjs', 'console.log(import.meta);\nlet static = 1;\n'],
  ['esm-import-redeclared.mjs', "import x from 'x';\nlet x;\nconst y = ;\n"],
  ['esm-import-attributes-multiline.mjs', "import x from './x.json' with {\n type: 'json'\n};\nconst y = 1 2;\n"],
  ['esm-module-syntax-mix.mjs', "import d, { a as b, c } from 'm';\nimport * as ns from 'n';\nimport 'side';\nexport * from 'q';\nexport * as w from 'q';\nexport { b as bb };\nexport const e = `${import.meta.url}`;\nexport default function () {}\nlet let = 3;\n"],
  ['esm-import-redeclared-function.mjs', "import { a } from 'm';\nfunction a() {}\n"],
  ['cjs-redeclared-async-function.js', 'let a;\nasync function a() {}\n'],
  ['cjs-redeclared-generator.js', 'let a;\nfunction* a() {}\n'],
  ['cjs-redeclared-class.js', 'let a;\nclass a extends Object { m() { return `${1}`; } }\n'],
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
