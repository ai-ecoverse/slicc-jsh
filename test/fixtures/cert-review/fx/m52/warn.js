const fs = require('fs'), f = require('path').join(require('os').tmpdir(), 'm52warn'); fs.writeFileSync(f, 'x');
const w = []; process.on('warning', (x) => w.push(`${x.code}`));
fs.chmodSync(f, 0o600); fs.chmodSync(f, 0o640); fs.fchmodSync(fs.openSync(f, 'r'), 0o644); fs.chmod(f, 0o600, () => fs.promises.chmod(f, 0o644).then(() => setTimeout(() => { console.log('warnings', w.length, JSON.stringify(w)); fs.unlinkSync(f); }, 50)));
