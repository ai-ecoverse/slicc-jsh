const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchfile-unref-'));
const a = path.join(dir, 'a.txt');
const b = path.join(dir, 'b.txt');
const c = path.join(dir, 'c.txt');
for (const f of [a, b, c]) fs.writeFileSync(f, 'x');

// Neither of these keeps the program alive.
fs.watchFile(a, { interval: 10, persistent: false }, () => console.log('a changed'));
fs.watchFile(b, { interval: 10 }, () => console.log('b changed')).unref();

// This one does, until it's unwatched. With the default interval its next
// poll is 5 s away, so the change at 50 ms isn't seen by then.
let seen = 0;
fs.watchFile(c, () => seen++);
setTimeout(() => fs.writeFileSync(c, 'changed'), 50).unref();
setTimeout(() => {
  console.log('default interval, changes seen in 500 ms:', seen);
  fs.unwatchFile(c);
}, 500);

process.on('exit', (code) => {
  console.log('exit', code, process.getActiveResourcesInfo().filter((r) => r === 'StatWatcher'));
  fs.rmSync(dir, { recursive: true });
});
console.log('end of script');
