const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-cache-')));
const pkg = (name, manifest) => {
  fs.mkdirSync(path.join(dir, 'node_modules', name), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', name, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'node_modules', name, 'index.js'), 'module.exports = 1;');
};
pkg('with-exports', { name: 'with-exports', exports: './index.js' });
pkg('with-main', { name: 'with-main', main: './index.js' });
fs.writeFileSync(path.join(dir, 'local.js'), 'module.exports = 1;');
const req = createRequire(path.join(dir, 'x.js'));
const show = (request) => {
  try {
    console.log(request, path.relative(dir, req.resolve(request)));
  } catch (err) {
    console.log(request, err.code);
  }
};
for (const request of ['with-exports', 'with-main', './local']) show(request);
setImmediate(() => {
  fs.unlinkSync(path.join(dir, 'node_modules', 'with-exports', 'index.js'));
  fs.unlinkSync(path.join(dir, 'node_modules', 'with-main', 'index.js'));
  fs.unlinkSync(path.join(dir, 'local.js'));
  for (const request of ['with-exports', 'with-main', './local', './other']) show(request);
  fs.rmSync(dir, { recursive: true, force: true });
});
