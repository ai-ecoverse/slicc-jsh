// Each change is made from a 'change' listener, so the order is fixed;
// the 10 ms interval keeps it quick.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchfile-'));
const file = path.join(dir, 'a.txt');
const watching = () => process.getActiveResourcesInfo().filter((r) => r === 'StatWatcher').length;
const brief = (s) =>
  [
    `size=${s.size}`,
    `nlink=${s.nlink}`,
    `mode=${s.mode.toString(8)}`,
    `file=${s.isFile()}`,
    `ino=${s.ino > 0}`,
    `mtimeMs=${s.mtimeMs > 0}`,
    `epoch=${s.mtime.getTime() === 0}`,
    `blksize=${s.blksize}`,
  ].join(' ');

function surface(w) {
  console.log('StatWatcher:', w.constructor.name, w instanceof EventEmitter);
  console.log('prototype:', Object.getOwnPropertyNames(Object.getPrototypeOf(w)).sort().join(','));
  console.log('start() is a no-op:', w.start());
}

// A missing file, two listeners, one watcher.
const steps = [
  () => fs.writeFileSync(file, 'hello'),
  () => fs.appendFileSync(file, ' world'),
  () => fs.unlinkSync(file),
];
let n = 0;
function first(curr, prev) {
  console.log(`change ${n}: curr ${brief(curr)}`);
  console.log(`change ${n}: prev ${brief(prev)}`);
  const step = steps[n++];
  if (step) step();
  else {
    fs.unwatchFile(file, first);
    console.log('after unwatchFile(file, first):', w.listenerCount('change'), 'listener(s),', watching(), 'watching');
    fs.unwatchFile(file);
    console.log('after unwatchFile(file):', w.listenerCount('change'), 'listener(s),', watching(), 'watching');
  }
}
let seconds = 0;
const second = () => seconds++;
const w = fs.watchFile(file, { interval: 10 }, first);
surface(w);
console.log('same watcher:', fs.watchFile(file, second) === w, w.listenerCount('change'));
console.log('a relative path is the same file:', fs.watchFile(path.relative(process.cwd(), file), second) === w);
fs.unwatchFile(file, second);
console.log('watching:', watching());
w.on('stop', () => {
  console.log('stop; the second listener saw', seconds, 'changes');
  bigints();
});

// bigint Stats, from a file there at the start (no event until it changes).
function bigints() {
  const big = path.join(dir, 'big.txt');
  fs.writeFileSync(big, 'x');
  // Grow it until a poll has seen it (the first poll's time isn't ours).
  const grow = setInterval(() => fs.appendFileSync(big, 'x'), 25);
  const b = fs.watchFile(big, { interval: 10, bigint: true }, (curr, prev) => {
    clearInterval(grow);
    console.log('bigint:', typeof curr.size, typeof prev.size, curr.size > prev.size, typeof curr.mtimeNs, curr.mtimeNs > 0n, curr.isFile());
    fs.unwatchFile(big);
    refs();
  });
  console.log('bigint watcher:', b instanceof EventEmitter);
}

// ref / unref, counted per listener as Node 22 counts them.
function refs() {
  const r = path.join(dir, 'r.txt');
  const l1 = () => {};
  const l2 = () => {};
  const w = fs.watchFile(r, { interval: 10 }, l1);
  fs.watchFile(r, l2);
  console.log('unref returns it:', w.unref() === w, watching());
  console.log('one unref of two refs:', watching());
  w.unref();
  console.log('both unref:', watching());
  w.unref();
  console.log('a third unref:', watching());
  console.log('ref returns it:', w.ref() === w, watching());
  w.ref();
  w.ref();
  console.log('ref past the listener count:', watching());
  w.unref();
  w.unref();
  console.log('unref twice:', watching());
  w.ref();
  fs.unwatchFile(r, l1);
  console.log('unwatchFile one listener:', watching(), w.listenerCount('change'));
  w.stop();
  console.log('stop():', watching(), 'stop again:', w.stop());
  console.log('the map keeps a stopped watcher:', fs.watchFile(r, l1) === w);
  fs.unwatchFile(r);
  errors();
}

function errors() {
  const t = (label, fn) => {
    try {
      fn();
      console.log(label, 'ok');
    } catch (e) {
      console.log(label, e.code, e.message);
    }
  };
  t('no listener:', () => fs.watchFile(file));
  t('options, no listener:', () => fs.watchFile(file, {}));
  t('null options:', () => fs.watchFile(file, null, () => {}));
  t('interval -1:', () => fs.watchFile(file, { interval: -1 }, () => {}));
  t('interval string:', () => fs.watchFile(file, { interval: '10' }, () => {}));
  t('interval 1.5:', () => fs.watchFile(file, { interval: 1.5 }, () => {}));
  t('path number:', () => fs.watchFile(1, () => {}));
  t('path NUL:', () => fs.watchFile('a\0b', () => {}));
  t('path Buffer:', () => fs.watchFile(Buffer.from(file), () => {}));
  t('unwatchFile number:', () => fs.unwatchFile(1));
  t('unwatchFile unknown:', () => fs.unwatchFile(path.join(dir, 'nope')));
  const u = fs.watchFile(new URL(`file://${path.join(dir, 'u.txt')}`), () => {});
  t('URL:', () => console.log(fs.watchFile(path.join(dir, 'u.txt'), () => {}) === u));
  fs.unwatchFile(new URL(`file://${path.join(dir, 'u.txt')}`));
  fs.rmSync(dir, { recursive: true });
  console.log('done');
}
