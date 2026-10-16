const fs = require('fs'); const T = process.argv[2];
Promise.resolve().then(() => fs.writeFileSync(T + '.micro', 'x')); setTimeout(() => fs.writeFileSync(T + '.timer', 'x'), 0); setImmediate(() => fs.writeFileSync(T + '.immediate', 'x')); process.nextTick(() => fs.writeFileSync(T + '.tick', 'x'));
process.on('SIGTERM', () => fs.writeFileSync(T + '.sig', 'x'));
(async () => { try { await null; process.exit(6); } finally { fs.writeFileSync(T + '.asyncfinally', 'x'); } })();
