// fs.watch with `recursive`, as Node 22 has it on Linux: its own JS watcher
// (lib/internal/fs/recursive_watch.js), a watch on each file and directory
// of the tree. The program makes each change itself and waits 100 ms before
// the next.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-r-'));
const at = (...names) => path.join(dir, ...names);
const hide = (s) => String(s).split(dir).join('<dir>');
fs.mkdirSync(at('old'));
fs.writeFileSync(at('old', 'o.txt'), 'o');

const w = fs.watch(dir, { recursive: true }, (type, name) => console.log('event:', type, name));
console.log('constructor:', w.constructor.name, 'ref/unref:', w.ref(), w.unref());

const steps = [
  ['write in an existing subdirectory', () => fs.writeFileSync(at('old', 'o.txt'), 'oo')],
  ['mkdir', () => fs.mkdirSync(at('sub'))],
  ['create in it', () => fs.writeFileSync(at('sub', 'a.txt'), 'a')],
  ['append', () => fs.appendFileSync(at('sub', 'a.txt'), 'b')],
  ['mkdir deeper', () => fs.mkdirSync(at('sub', 'deep'))],
  ['create deeper', () => fs.writeFileSync(at('sub', 'deep', 'd.txt'), 'd')],
  ['change deeper', () => fs.appendFileSync(at('sub', 'deep', 'd.txt'), 'e')],
  ['unlink', () => fs.unlinkSync(at('sub', 'a.txt'))],
  ['create at the top', () => fs.writeFileSync(at('top.txt'), 't')],
  [
    'close',
    () => {
      w.close();
      fs.writeFileSync(at('after-close.txt'), 'x');
    },
  ],
];
w.on('close', () => console.log('close'));
let n = 0;
const next = () => {
  const step = steps[n++];
  if (!step) return errors();
  console.log(`-- ${step[0]}`);
  step[1]();
  setTimeout(next, 100);
};
setTimeout(next, 100);

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
