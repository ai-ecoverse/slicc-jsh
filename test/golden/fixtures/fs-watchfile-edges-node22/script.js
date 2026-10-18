const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchfile-edges-'));
const done = () => {
  fs.rmSync(dir, { recursive: true });
  console.log('done');
};

// A listener that writes to the Stats it gets: polls go on comparing the
// file's real stat, so an unchanged file gives no more events.
function mutate(next) {
  const file = path.join(dir, 'm.txt');
  fs.writeFileSync(file, 'x');
  let events = 0;
  let first = true;
  // Grow it until a poll has seen it (the first poll's time isn't ours).
  const grow = setInterval(() => fs.appendFileSync(file, 'x'), 25);
  fs.watchFile(file, { interval: 10 }, (curr, prev) => {
    clearInterval(grow);
    events++;
    curr.size = 1e6;
    curr.mtimeMs = 1;
    prev.size = 2e6;
    if (!first) return;
    first = false;
    // Let a last append's event come, then count over a quiet 200 ms.
    setTimeout(() => {
      events = 0;
      setTimeout(() => {
        console.log('events for an unchanged file after changing the Stats:', events);
        fs.unwatchFile(file);
        next();
      }, 200);
    }, 100);
  });
}

// Node's interval is a uint32: 4294967295 ms is about 49 days, so the file
// appearing a moment after the first poll isn't seen.
function longInterval(next) {
  const file = path.join(dir, 'l.txt');
  const seen = [];
  fs.watchFile(file, { interval: 2 ** 32 - 1 }, (curr) => seen.push(curr.size));
  setTimeout(() => fs.writeFileSync(file, 'abc'), 100);
  setTimeout(() => {
    console.log('long interval, sizes seen:', seen);
    fs.unwatchFile(file);
    next();
  }, 300);
}

mutate(() => longInterval(done));
