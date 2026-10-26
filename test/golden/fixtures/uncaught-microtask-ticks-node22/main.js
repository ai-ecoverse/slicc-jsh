const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ticks-')));
const run = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', argv0: 'node', input });
  console.log(`== ${JSON.stringify(args.map((a) => a.split(dir).join('DIR')))}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status}`);
  console.log(JSON.stringify(r.stderr.split(dir).join('DIR').replace(/\(node:\d+\)/g, '(node:PID)')));
};
const cases = [
  'queueMicrotask(() => { throw 1 })',
  'require("fs").readFile(__filename + "x", () => queueMicrotask(() => { throw 10 }))',
  'process.emitWarning("w"); queueMicrotask(() => { throw "z" })',
  'process.nextTick(() => {}); queueMicrotask(() => { throw 2 })',
  'queueMicrotask(() => { process.nextTick(() => {}); queueMicrotask(() => { throw 3 }) })',
  'queueMicrotask(() => process.nextTick(() => queueMicrotask(() => { throw 4 })))',
  'Promise.resolve().then(() => { process.nextTick(() => {}) }); queueMicrotask(() => queueMicrotask(() => { throw 5 }))',
  'setTimeout(() => { process.nextTick(() => {}); queueMicrotask(() => { throw 6 }) })',
  'process.nextTick(() => {}); setTimeout(() => queueMicrotask(() => { throw 7 }))',
  'setImmediate(() => { process.nextTick(() => {}); queueMicrotask(() => { throw 8 }) })',
  'process.nextTick(() => {}); require("fs").readFile(__filename + "x", () => queueMicrotask(() => { throw 9 }))',
  'require("fs").readFile(__filename + "x", () => { process.nextTick(() => {}); queueMicrotask(() => { throw 11 }) })',
  'process.nextTick(() => {}); require("dns").lookup("localhost", () => queueMicrotask(() => { throw 12 }))',
  'require("dns").lookup("localhost", () => { process.nextTick(() => {}); queueMicrotask(() => { throw 13 }) })',
  'process.nextTick(() => {}); queueMicrotask(() => { throw {get stack() { throw 1 }} })',
];
cases.forEach((code, i) => {
  const file = path.join(dir, `case-${i}.js`);
  fs.writeFileSync(file, `${code}\n`);
  run(['-e', code]);
  run([], code);
  run([file]);
});
const modules = [
  'process.nextTick(() => {}); queueMicrotask(() => { throw 14 })',
  'process.nextTick(() => queueMicrotask(() => { throw 15 }))',
  'process.nextTick(() => {}); queueMicrotask(() => queueMicrotask(() => { throw 16 }))',
  'process.nextTick(() => { console.error("tick"); queueMicrotask(() => { throw 17 }) }); Promise.resolve().then(() => console.error("then")); queueMicrotask(() => console.error("micro"))',
];
modules.forEach((code, i) => {
  const file = path.join(dir, `module-${i}.mjs`);
  fs.writeFileSync(file, `${code}\n`);
  run(['--input-type=module', '-e', code]);
  run(['--input-type=module'], code);
  run([file]);
});
fs.rmSync(dir, { recursive: true, force: true });
