const fs = require('fs');
const path = require('path');
const os = require('os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnimp-'));
fs.mkdirSync(path.join(dir, 'sub'));
fs.writeFileSync(path.join(dir, 'x.mjs'), 'export default "from dir";');
fs.writeFileSync(path.join(dir, 'sub', 'x.mjs'), 'export default "from sub";');
// The caller lives in sub/: its new Function imports resolve from there.
fs.writeFileSync(
  path.join(dir, 'sub', 'caller.js'),
  'module.exports = () => new Function("s", "return import(s)")("./x.mjs");'
);
const AsyncFunction = (async () => {}).constructor;
(async () => {
  console.log('function', (await require(path.join(dir, 'sub', 'caller.js'))()).default);
  const viaSelf = new Function('s', 'return import(s)');
  console.log('builtin', typeof (await viaSelf('node:path')).join);
  console.log('absolute', (await viaSelf(path.join(dir, 'x.mjs'))).default);
  const af = new AsyncFunction('p', 'const m = await import(p); return m.default;');
  console.log('async function', await af(path.join(dir, 'sub', 'x.mjs')));
  console.log('constructor', Function.name, af instanceof AsyncFunction, viaSelf instanceof Function, (function () {}).constructor === Function);
  console.log('string only', new Function('return "import(x) in a string"')());
  try {
    new Function('import(');
  } catch (e) {
    console.log('syntax', e.name);
  }
  fs.rmSync(dir, { recursive: true, force: true });
})();
