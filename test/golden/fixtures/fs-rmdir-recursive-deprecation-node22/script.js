// DEP0147 (#280): fs.rmdir, fs.rmdirSync and fs.promises.rmdir with
// `recursive` warn once per process, as Node 22's emitRecursiveRmdirWarning.
// stderr is captured in process (the pid varies) and printed to stdout.
const captured = [];
process.stderr.write = (chunk) => {
  captured.push(String(chunk).replace(/\(node:\d+\)/g, '(node:PID)'));
  return true;
};
const fs = require('fs');
const os = require('os');
const path = require('path');
process.on('warning', (w) => console.log('listener:', w.name, w.code, JSON.stringify(w.message)));
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dep0147-'));
fs.mkdirSync(path.join(d, 'a/b'), { recursive: true });
fs.mkdirSync(path.join(d, 'c/d'), { recursive: true });
fs.mkdirSync(path.join(d, 'e'));
fs.rmdirSync(path.join(d, 'e'));
console.log('plain rmdirSync: no warning');
fs.rmdir(path.join(d, 'a'), { recursive: true }, (err) => {
  console.log('rmdir recursive cb', err, fs.existsSync(path.join(d, 'a')));
  fs.rmdirSync(path.join(d, 'c'), { recursive: true });
  console.log('rmdirSync recursive', fs.existsSync(path.join(d, 'c')));
  fs.promises.rmdir(d, { recursive: true }).then(() => {
    console.log('promises.rmdir recursive', fs.existsSync(d));
    setImmediate(() => console.log('stderr:\n' + captured.join('')));
  });
});
