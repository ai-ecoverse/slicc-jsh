const cp = require('child_process');
const fs = require('fs');
const dir = fs.realpathSync(process.cwd());
const clean = (s) =>
  String(s)
    .split(dir)
    .join('<dir>')
    .split('\n')
    .filter((l) => !/^\s+at /.test(l))
    .map((l) => l.replace(/^.*: either --check/, 'node: either --check').replace(/^\(node:\d+\)/, '(node:PID)'))
    .join('\n');
const run = (label, args, input) => {
  const r = cp.spawnSync(process.execPath, args, { encoding: 'utf8', input });
  console.log(`== ${label}: status ${r.status}`);
  if (r.stdout) console.log(`stdout: ${JSON.stringify(r.stdout)}`);
  if (r.stderr) console.log(clean(r.stderr));
};
run('-c ok.js', ['-c', 'ok.js']);
run('--check ok.js a b', ['--check', 'ok.js', 'a', 'b']);
run('-c bad.js', ['-c', 'bad.js']);
run('-c esm.js (detected)', ['-c', 'esm.js']);
run('-c badesm.mjs', ['-c', 'badesm.mjs']);
run('-c hb.js (hashbang)', ['-c', 'hb.js']);
run('-c ret.js (return in CommonJS)', ['-c', 'ret.js']);
run('-c redecl.js', ['-c', 'redecl.js']);
run('-c tla.js', ['-c', 'tla.js']);
// Without a "type", detect-module: module syntax makes an ES module.
run('-c auto/esm.js', ['-c', 'auto/esm.js']);
run('-c auto/redecl.js', ['-c', 'auto/redecl.js']);
run('-c auto/tla.js', ['-c', 'auto/tla.js']);
run('-c -e', ['-c', '-e', 'console.log(1)']);
run('-p 1 -c', ['-p', '1', '-c']);
run('-c, piped, bad', ['-c'], 'let z = ;\n');
run('-c -, piped, good', ['-c', '-'], 'console.log("ran")\n');
run('-c, piped import as CommonJS', ['-c'], 'import fs from "fs";\n');
run('-c --input-type=module, piped import', ['-c', '--input-type=module'], 'import fs from "fs";\n');
