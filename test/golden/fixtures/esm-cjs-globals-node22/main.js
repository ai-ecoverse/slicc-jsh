const { spawnSync } = require('child_process');
const { realpathSync } = require('fs');
const dir = realpathSync(__dirname);
const run = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node', input });
  const shown = (text) => text.split(dir).join('DIR').split(__dirname).join('DIR').split('\n').filter((line) => !line.startsWith('    at ')).join('\n');
  console.log(`== ${JSON.stringify(args)}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status}`);
  console.log(JSON.stringify(shown(r.stdout)));
  console.log(JSON.stringify(shown(r.stderr)));
};
for (const file of ['read.mjs', 'require.mjs', 'module.mjs', 'exports.mjs', 'filename.mjs', 'dirname.mjs', 'nested.mjs', 'timer.mjs', 'await.mjs', 'static.mjs', 'dynamic.mjs', 'dynamic-catch.mjs', 'from-cjs.cjs', 'require-esm.cjs', 'pkg/c.js']) run([file]);
run(['--input-type=module', '-e', 'require("fs")']);
run(['--input-type=module'], 'try { require } catch (x) { console.log(x.message) }');
run(['-e', 'console.log(typeof require, typeof module, typeof exports, __filename, __dirname, Object.keys(globalThis).filter((n) => ["require", "module", "exports", "__filename", "__dirname"].includes(n)))']);
run([], 'console.log(typeof require, typeof module, __filename)');
