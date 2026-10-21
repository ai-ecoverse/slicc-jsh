const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-overwrite-'));
const at = (...p) => path.join(root, ...p);

fs.mkdirSync(at('s'));
let sentinels = 0;
let waiting = null;
const sentinel = fs.watch(at('s'), (type, name) => {
  if (waiting?.name === name) {
    const { resolve } = waiting;
    waiting = null;
    setImmediate(resolve);
  }
});

const events = [];
const watch = (label, file, options = {}) =>
  fs.watch(file, options, (type, name) => events.push(`${label ? `${label} ` : ''}${type} ${name}`));

async function step(title, op) {
  console.log(`-- ${title}`);
  const name = `.s${sentinels++}`;
  const done = new Promise((resolve) => {
    waiting = { name, resolve };
  });
  op();
  fs.mkdirSync(at('s', name));
  await done;
  console.log(events.splice(0).join(', ') || '(none)');
}

setTimeout(() => {
  console.log('stuck');
  process.exit(1);
}, 10000).unref();

(async () => {
  fs.mkdirSync(at('r', 'sub'), { recursive: true });
  fs.writeFileSync(at('r', 'c.txt'), 'c');
  fs.writeFileSync(at('r', 'sub', 'o.txt'), 'o');
  const r = watch('', at('r'), { recursive: true });
  await step('recursive: overwrite', () => fs.writeFileSync(at('r', 'c.txt'), 'cc'));
  await step('recursive: overwrite in a subdirectory', () => fs.writeFileSync(at('r', 'sub', 'o.txt'), 'oo'));
  await step('recursive: empty overwrite', () => fs.writeFileSync(at('r', 'c.txt'), ''));
  await step('recursive: append', () => fs.appendFileSync(at('r', 'c.txt'), 'x'));
  r.close();

  fs.mkdirSync(at('f'));
  fs.writeFileSync(at('f', 'f.txt'), 'f');
  const f = watch('', at('f', 'f.txt'));
  await step('file: overwrite', () => fs.writeFileSync(at('f', 'f.txt'), 'ff'));
  await step('file: empty overwrite', () => fs.writeFileSync(at('f', 'f.txt'), ''));
  await step('file: append', () => fs.appendFileSync(at('f', 'f.txt'), 'x'));
  await step('file: overwrite, then append', () => {
    fs.writeFileSync(at('f', 'f.txt'), 'fff');
    fs.appendFileSync(at('f', 'f.txt'), 'x');
  });
  f.close();

  fs.mkdirSync(at('d'));
  fs.writeFileSync(at('d', 'd.txt'), 'd');
  const d = watch('', at('d'));
  await step('directory: overwrite', () => fs.writeFileSync(at('d', 'd.txt'), 'dd'));
  d.close();

  fs.mkdirSync(at('t'));
  fs.writeFileSync(at('t', 't.txt'), 't');
  const a = watch('A', at('t', 't.txt'));
  const b = watch('B', at('t', 't.txt'));
  await step('two watchers on one file: overwrite', () => fs.writeFileSync(at('t', 't.txt'), 'tt'));
  await step('two watchers on one file: append', () => fs.appendFileSync(at('t', 't.txt'), 'x'));
  b.close();
  await step('two watchers on one file: the second closed, then an append', () => fs.appendFileSync(at('t', 't.txt'), 'x'));
  a.close();

  fs.mkdirSync(at('u'));
  const c = watch('A', at('u'));
  const e = watch('B', at('u'));
  await step('two watchers on one directory: a file created', () => fs.writeFileSync(at('u', 'n.txt'), 'n'));
  c.close();
  e.close();

  fs.mkdirSync(at('v'));
  fs.writeFileSync(at('v', 'v.txt'), 'v');
  const file = watch('file', at('v', 'v.txt'));
  const dir = watch('dir', at('v'));
  await step('a file and its directory: overwrite', () => fs.writeFileSync(at('v', 'v.txt'), 'vv'));
  await step('a file and its directory: append', () => fs.appendFileSync(at('v', 'v.txt'), 'x'));
  file.close();
  dir.close();

  fs.mkdirSync(at('y', 'w'), { recursive: true });
  const child = watch('dir', at('y', 'w'));
  const parent = watch('parent', at('y'));
  await step('a directory watched before its parent: the directory removed', () => fs.rmdirSync(at('y', 'w')));
  child.close();
  parent.close();

  fs.mkdirSync(at('z', 'w', 'w'), { recursive: true });
  const same = watch('', at('z', 'w'));
  await step('a directory with an entry of its own name: both removed', () => {
    fs.rmdirSync(at('z', 'w', 'w'));
    fs.rmdirSync(at('z', 'w'));
  });
  same.close();

  sentinel.close();
  fs.rmSync(root, { recursive: true });
  console.log('done');
})();
