const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-follow-'));
const at = (...p) => path.join(root, ...p);

function watch(file, options = {}) {
  const base = path.basename(file);
  const w = { events: [], all: [], waiting: null };
  const over = () => w.all.length >= 2 && w.all.slice(-2).every((e) => e === `rename ${base}`);
  w.settle = () => {
    const { waiting } = w;
    if (!waiting || (w.events.length < waiting.count && !over())) return;
    w.waiting = null;
    setImmediate(waiting.resolve);
  };
  w.handle = fs.watch(file, options, (type, name) => {
    const event = `${type} ${name}`;
    w.events.push(event);
    w.all.push(event);
    w.settle();
  });
  return w;
}

async function step(w, title, count, op) {
  console.log(`-- ${title}`);
  const done = new Promise((resolve) => {
    w.waiting = { count, resolve };
  });
  op();
  w.settle();
  await done;
  console.log(w.events.splice(0).join(', ') || '(none)');
}

const append = (file) => fs.appendFileSync(file, 'x');

setTimeout(() => {
  console.log('stuck');
  process.exit(1);
}, 10000).unref();

(async () => {
  fs.mkdirSync(at('a', 'd'), { recursive: true });
  fs.writeFileSync(at('a', 'd', 'f'), '1');
  const a = watch(at('a', 'd', 'f'));
  await step(a, 'file: its directory renamed, then the file appended to', 1, () => {
    fs.renameSync(at('a', 'd'), at('a', 'e'));
    append(at('a', 'e', 'f'));
  });
  await step(a, 'file: removed', 3, () => fs.unlinkSync(at('a', 'e', 'f')));
  a.handle.close();

  fs.mkdirSync(at('b'));
  fs.writeFileSync(at('b', 'f'), '1');
  const b = watch(at('b', 'f'));
  await step(b, 'file: renamed', 1, () => fs.renameSync(at('b', 'f'), at('b', 'g')));
  await step(b, 'file: appended to under its new name', 1, () => append(at('b', 'g')));
  await step(b, 'file: removed under its new name', 3, () => fs.unlinkSync(at('b', 'g')));
  b.handle.close();

  fs.mkdirSync(at('c', 'p', 'w'), { recursive: true });
  const c = watch(at('c', 'p', 'w'));
  await step(c, 'directory: renamed', 1, () => fs.renameSync(at('c', 'p', 'w'), at('c', 'p', 'x')));
  await step(c, 'directory: mkdir in it under its new name', 1, () => fs.mkdirSync(at('c', 'p', 'x', 'n')));
  await step(c, 'directory: its parent renamed, then a mkdir in it', 1, () => {
    fs.renameSync(at('c', 'p'), at('c', 'q'));
    fs.mkdirSync(at('c', 'q', 'x', 'm'));
  });
  await step(c, 'directory: emptied and removed', 4, () => {
    fs.rmdirSync(at('c', 'q', 'x', 'm'));
    fs.rmdirSync(at('c', 'q', 'x', 'n'));
    fs.rmdirSync(at('c', 'q', 'x'));
  });
  c.handle.close();

  fs.mkdirSync(at('r', 't'), { recursive: true });
  fs.writeFileSync(at('r', 't', 'a'), '1');
  const r = watch(at('r', 't'), { recursive: true });
  await step(r, 'recursive: its parent renamed and back, then a file appended to', 1, () => {
    fs.renameSync(at('r'), at('r2'));
    fs.renameSync(at('r2'), at('r'));
    append(at('r', 't', 'a'));
  });
  r.handle.close();

  fs.rmSync(root, { recursive: true });
  console.log('done');
})();
