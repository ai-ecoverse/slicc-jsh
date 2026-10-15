const fs = require('fs'), cp = require('child_process');
const mode = process.argv[2];
let tty; try { fs.closeSync(fs.openSync('/dev/tty', 'r+')); tty = 'opened'; } catch (e) { tty = e.code; }
if (mode === 'grand') { const g = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' }); g.on('spawn', () => console.log(JSON.stringify({ tty, grand: g.pid }))); }
else if (mode === 'kill0') { process.on('SIGTERM', () => {}); process.kill(0, 'SIGTERM'); console.log(JSON.stringify({ tty, kill0: 'sent' })); }
else if (mode === 'late') { setTimeout(() => fs.writeFileSync(process.argv[3], 'still-ran'), 5000); }
else console.log(JSON.stringify({ tty }));
setTimeout(() => {}, mode === 'grand' ? 20000 : mode === 'plain' ? 1500 : mode === 'late' ? 5500 : 300);
