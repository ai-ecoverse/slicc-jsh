// fs.watch as Node 22 reports it on Linux (inotify). The program makes each
// change itself, after fs.watch has returned, and waits 100 ms before the
// next, so each change's events are read on their own. Each watcher's events
// are printed together after each step: the order between two watchers is
// the kernel's, not part of what fs.watch promises.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
const at = (name) => path.join(dir, name);
const hide = (s) => String(s).split(dir).join('<dir>');
const watching = () => process.getActiveResourcesInfo().filter((r) => r === 'FSEventWrap').length;
fs.writeFileSync(at('f.txt'), 'f');
fs.mkdirSync(at('nested'));

// The changes come straight after the call: the watch is in place when it returns.
const seen = { dir: [], file: [], hex: [] };
const flush = () => {
  for (const [who, events] of Object.entries(seen)) {
    if (events.length) console.log(`${who}:`, events.splice(0).join(', '));
  }
};
const dw = fs.watch(dir, (type, name) => seen.dir.push(`${type} ${name}`));
fs.writeFileSync(at('a.txt'), 'a');
console.log('FSWatcher:', dw.constructor.name, dw instanceof EventEmitter, 'exported:', 'FSWatcher' in fs);
console.log('prototype:', Object.getOwnPropertyNames(Object.getPrototypeOf(dw)).sort().join(','));
console.log('ref/unref return it:', dw.unref() === dw, dw.ref() === dw, 'start():', dw.start());
console.log('active:', watching());

const fw = fs.watch(at('f.txt'), { encoding: 'buffer' });
fw.on('change', (type, name) => seen.file.push(`${type} ${Buffer.isBuffer(name)} ${name}`));
const hw = fs.watch(at('f.txt'), 'hex', (type, name) => seen.hex.push(`${type} ${name}`));
console.log('active:', watching());

const steps = [
  ['append', () => fs.appendFileSync(at('a.txt'), 'b')],
  ['overwrite', () => fs.writeFileSync(at('a.txt'), 'c')],
  ['chmod', () => fs.chmodSync(at('a.txt'), 0o600)],
  ['rename', () => fs.renameSync(at('a.txt'), at('b.txt'))],
  ['mkdir', () => fs.mkdirSync(at('sub'))],
  ['nested write (not reported)', () => fs.writeFileSync(at('nested/n.txt'), 'n')],
  ['unlink', () => fs.unlinkSync(at('b.txt'))],
  ['rmdir', () => fs.rmdirSync(at('sub'))],
  ['append to the watched file', () => fs.appendFileSync(at('f.txt'), 'g')],
  ['unlink the watched file', () => fs.unlinkSync(at('f.txt'))],
  [
    'close',
    () => {
      hw.close();
      fw.close();
      fw.close();
      fs.writeFileSync(at('after-close.txt'), 'x');
      dw.close();
    },
  ],
];
dw.on('close', () => {
  console.log('dir: close');
  errors();
});
fw.on('close', () => console.log('file: close'));
let n = 0;
const next = () => {
  flush();
  const step = steps[n++];
  if (!step) return;
  console.log(`-- ${step[0]}`);
  step[1]();
  setTimeout(next, 100);
};
setTimeout(next, 100);

function errors() {
  const show = (f) => {
    try {
      f();
      console.log('no error');
    } catch (e) {
      console.log(e.code, hide(e.message), e.errno, e.syscall, hide(e.path), hide(e.filename));
    }
  };
  show(() => fs.watch(at('missing')));
  process.chdir(dir);
  show(() => fs.watch('missing'));
  show(() => fs.watch(Buffer.from(at('missing'))));
  show(() => fs.watch(42));
  show(() => fs.watch(dir, 42));
  show(() => fs.watch(dir, { encoding: 'nope' }));
  show(() => fs.watch(dir, { signal: {} }));
  show(() => fs.watch(at('x\0y')));
  // The options are checked before the path.
  show(() => fs.watch(at('x\0y'), 42));
  show(() => fs.watch(require('url').pathToFileURL(at('missing'))));
  show(() => fs.watch(new URL('http://host/')));
  // A falsy encoding is the default.
  for (const encoding of ['', false, 0, null]) show(() => fs.watch(dir, { encoding }).close());
  signals();
}

// An AbortSignal closes the watcher, even after a listener that stops the
// abort event's propagation; an aborted one closes it on the next tick.
function signals() {
  const ac = new AbortController();
  ac.signal.addEventListener('abort', (e) => e.stopImmediatePropagation());
  const w = fs.watch(dir, { signal: ac.signal });
  w.on('close', () => {
    console.log('aborted: close');
    const w2 = fs.watch(dir, { signal: AbortSignal.abort() });
    w2.on('close', () => {
      console.log('pre-aborted: close');
      persistence();
    });
  });
  ac.abort();
}

// Not persistent, or unref'd: the program ends while they watch. (Node lists
// a closed or failed watcher's handle until it is freed, so the counts above
// are taken only while every watcher is open.)
function persistence() {
  fs.watch(dir, { persistent: false }, () => console.log('unexpected'));
  fs.watch(dir).unref();
  process.on('exit', () => console.log('exit while watching'));
}
