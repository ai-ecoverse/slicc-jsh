const fs = require('fs');
for (const [label, f] of [
  ['readFileSync missing', () => fs.readFileSync('missing.txt')],
  ['readFileSync dir', () => fs.readFileSync('dir')],
  ['readdirSync file', () => fs.readdirSync('data.txt')],
  ['mkdirSync exists', () => fs.mkdirSync('dir')],
  ['rmdirSync non-empty', () => fs.rmdirSync('dir')],
  ['unlinkSync missing', () => fs.unlinkSync('missing.txt')],
]) {
  try { f(); console.log(label, 'no error'); } catch (e) {
    console.log(label, JSON.stringify({ name: e.name, code: e.code, errno: e.errno, syscall: e.syscall, path: e.path, message: e.message, instanceofError: e instanceof Error }));
  }
}
console.log('dir/a.txt still there', fs.existsSync('dir/a.txt'));
