const fs = require('fs');
for (const name of ['setImmediate', 'setTimeout', 'setInterval', 'clearImmediate', 'clearTimeout', 'clearInterval']) {
  globalThis[name] = undefined;
}
process.on('uncaughtException', (err) => console.log('fs.rm', err.name, err.message));
fs.rm('/no/such/path');
process.on('exit', () => console.log('the program ends'));
