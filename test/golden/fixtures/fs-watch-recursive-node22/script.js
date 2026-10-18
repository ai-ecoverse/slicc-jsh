// fs.watch with `recursive`, as Node 22 has it on Linux: its own JS watcher
// (lib/internal/fs/recursive_watch.js), a watch on each file and directory
// of the tree. The program makes each change itself. A step ends when its
// events are in, not after a set time: each step expects one event, and
// then makes a sentinel directory ('.s1', ...) at the top and waits for it.
// The sentinel comes after the step's events in Node, whose watches share one
// inotify queue; jsh's are separate kernel watches, ordered only one by one,
// so there the expected event is what the step waits for.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-r-'));
const at = (...names) => path.join(dir, ...names);
const hide = (s) => String(s).split(dir).join('<dir>');
fs.mkdirSync(at('old'));
fs.writeFileSync(at('old', 'o.txt'), 'o');

let waiting = null;
const settle = () => {
  if (!waiting || !waiting.sentinel || waiting.events < 1) return;
  const { then } = waiting;
  waiting = null;
  then();
};
let sentinels = 0;
const w = fs.watch(dir, { recursive: true }, (type, name) => {
  if (name.startsWith('.s')) {
    if (waiting?.name === name) waiting.sentinel = true;
  } else {
    console.log('event:', type, name);
    if (waiting) waiting.events++;
  }
  settle();
});
console.log('constructor:', w.constructor.name, 'ref/unref:', w.ref(), w.unref());

const steps = [
  // An append: an overwrite is a truncate and a write, which Linux reports
  // twice here, from the file's watch and its directory's in turn (jsh: once).
  ['append in an existing subdirectory', () => fs.appendFileSync(at('old', 'o.txt'), 'o')],
  ['mkdir', () => fs.mkdirSync(at('sub'))],
  ['create in it', () => fs.writeFileSync(at('sub', 'a.txt'), 'a')],
  ['append', () => fs.appendFileSync(at('sub', 'a.txt'), 'b')],
  ['mkdir deeper', () => fs.mkdirSync(at('sub', 'deep'))],
  ['create deeper', () => fs.writeFileSync(at('sub', 'deep', 'd.txt'), 'd')],
  ['change deeper', () => fs.appendFileSync(at('sub', 'deep', 'd.txt'), 'e')],
  ['unlink', () => fs.unlinkSync(at('sub', 'a.txt'))],
  ['create at the top', () => fs.writeFileSync(at('top.txt'), 't')],
];
w.on('close', () => console.log('close'));
// A step whose events never come says which, rather than timing out silently.
setTimeout(() => {
  console.log('stuck in', steps[n - 1]?.[0] ?? 'the first step');
  process.exit(1);
}, 10000).unref();
let n = 0;
const next = () => {
  const step = steps[n++];
  if (!step) return close();
  console.log(`-- ${step[0]}`);
  waiting = { name: `.s${sentinels}`, sentinel: false, events: 0, then: next };
  step[1]();
  fs.mkdirSync(at(`.s${sentinels++}`));
};
next();

function close() {
  console.log('-- close');
  w.close();
  fs.writeFileSync(at('after-close.txt'), 'x');
  errors();
}

function errors() {
  const show = (f) => {
    try {
      f().close();
      console.log('no error');
    } catch (e) {
      console.log(e.code, hide(e.message), e.errno, e.syscall, hide(e.path), hide(e.filename));
    }
  };
  // Linux's recursive watcher stats the path first: the error is stat's.
  show(() => fs.watch(at('missing'), { recursive: true }));
  show(() => fs.watch(dir, { recursive: 'yes' }));
  show(() => fs.watch(dir, { recursive: true, persistent: 1 }));
  show(() => fs.watch(dir, { recursive: true, encoding: 'buffer' }));
}
