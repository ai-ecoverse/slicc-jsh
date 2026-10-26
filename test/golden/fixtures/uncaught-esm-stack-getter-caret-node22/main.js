const { spawnSync } = require('child_process');
const { realpathSync } = require('fs');
const dir = realpathSync(__dirname);
const run = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node', input });
  console.log(`== ${JSON.stringify(args)}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status}`);
  console.log(JSON.stringify(r.stderr.split(dir).join('DIR').split(__dirname).join('DIR')));
};
const inline = 'const e = new Error("x"); Object.defineProperty(e, "stack", { get() { return null.s } }); throw e;';
for (const file of ['inline.mjs', 'function.mjs', 'await.mjs', 'imported.mjs', 'subclass.mjs', 'prepare.mjs', 'read.mjs', 'read-await.mjs', 'object.mjs', 'timer.mjs']) run([file]);
run(['--input-type=module', '-e', inline]);
run(['--input-type=module'], inline);
run(['--input-type=module', '-e', 'throw {get stack() { throw 1 }}']);
run(['-e', inline]);
