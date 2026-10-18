// fs.watch as Node 22 reports it on Linux (inotify). The program makes each
// change itself, after fs.watch has returned. A step ends when its events
// are in, not after a set time: each step makes a sentinel directory
// ('.s1', '.s2', ...) in the watched directory, and a watcher's events come
// in order, so once the directory watch has the sentinel, the step's own
// events are in. The file watches see only the steps that touch their file,
// and those wait for the events they expect. Each watcher's events are
// printed together after each step: the order between two watchers is the
// kernel's, not part of what fs.watch promises.
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

const seen = { dir: [], file: [], hex: [] };
const flush = () => {
  for (const [who, events] of Object.entries(seen)) {
    if (events.length) console.log(`${who}:`, events.splice(0).join(', '));
  }
};
// The step waiting for its events: the sentinel's name, and how many events each file watch expects.
let waiting = null;
const settle = () => {
  if (!waiting || !waiting.sentinel || seen.file.length < waiting.file || seen.hex.length < waiting.hex) return;
  const { then } = waiting;
  waiting = null;
  // On a turn of its own, not inside the event's callback: there libuv is
  // still going through its watchers, and a watcher closed or started then
  // isn't yet (a recursive watcher, too, watches a new file only after it
  // has reported it).
  setImmediate(then);
};
let sentinels = 0;
/** Ends a step: its sentinel, then `then` once that and `expect`'s file events are in. */
const endStep = (expect, then) => {
  const name = `.s${sentinels++}`;
  waiting = { name, sentinel: false, file: expect.file ?? 0, hex: expect.hex ?? 0, then };
  fs.mkdirSync(at(name));
};

// The changes come straight after the call: the watch is in place when it returns.
const dw = fs.watch(dir, (type, name) => {
  if (name.startsWith('.s')) {
    if (waiting?.name === name) waiting.sentinel = true;
    return settle();
  }
  seen.dir.push(`${type} ${name}`);
});
fs.writeFileSync(at('a.txt'), 'a');
console.log('FSWatcher:', dw.constructor.name, dw instanceof EventEmitter, 'exported:', 'FSWatcher' in fs);
console.log('prototype:', Object.getOwnPropertyNames(Object.getPrototypeOf(dw)).sort().join(','));
console.log('ref/unref return it:', dw.unref() === dw, dw.ref() === dw, 'start():', dw.start());
console.log('active:', watching());

const fw = fs.watch(at('f.txt'), { encoding: 'buffer' });
fw.on('change', (type, name) => {
  seen.file.push(`${type} ${Buffer.isBuffer(name)} ${name}`);
  settle();
});
const hw = fs.watch(at('f.txt'), 'hex', (type, name) => {
  seen.hex.push(`${type} ${name}`);
  settle();
});
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
  ['append to the watched file', () => fs.appendFileSync(at('f.txt'), 'g'), { file: 1, hex: 1 }],
  // inotify: the link count, the delete, the end of the watch.
  ['unlink the watched file', () => fs.unlinkSync(at('f.txt')), { file: 3, hex: 3 }],
];
dw.on('close', () => {
  flush();
  console.log('dir: close');
  errors();
});
fw.on('close', () => console.log('file: close'));
// A step whose events never come says which, rather than timing out silently.
setTimeout(() => {
  console.log('stuck in', steps[n - 1]?.[0] ?? 'the first step');
  process.exit(1);
}, 10000).unref();
let n = 0;
const next = () => {
  flush();
  const step = steps[n++];
  if (!step) return close();
  console.log(`-- ${step[0]}`);
  step[1]();
  endStep(step[2] ?? {}, next);
};
// The first step waits for the create made right after fs.watch.
endStep({}, next);

function close() {
  console.log('-- close');
  hw.close();
  fw.close();
  fw.close();
  // Closed before anything is read: not reported.
  fs.writeFileSync(at('after-close.txt'), 'x');
  dw.close();
}

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
