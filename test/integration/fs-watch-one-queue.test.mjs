import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createFsWatch } from '../../src/runtime/builtins/fs-watch.mjs';
import { createHandleTable } from '../../src/runtime/handles.mjs';
import { withJsh } from './helpers.mjs';

function standInKernel(roundTrip) {
  let tail = Promise.resolve();
  const call = (fn) => {
    const run = tail.then(() => new Promise((resolve) => setTimeout(resolve, roundTrip()))).then(fn);
    tail = run.catch(() => undefined);
    return run;
  };
  const watches = new Map();
  let seq = 0;
  const watch = (at, _options, onNote) => {
    const w = { queue: [], result: null, blocked: null, closed: false };
    watches.set(at, w);
    const pump = async () => {
      while (!w.closed) {
        await call(() => undefined);
        const notes = await call(() => (w.queue.length ? w.queue.splice(0) : null)).then(
          (taken) => taken ?? new Promise((resolve) => (w.blocked = resolve)).then((woke) => call(() => woke))
        );
        for (const note of notes) if (!w.closed) onNote(note);
      }
    };
    pump();
    return {
      close: () => {
        w.closed = true;
      },
    };
  };
  const op = (...changes) => {
    seq++;
    for (const [at, type, filename] of changes) {
      const w = watches.get(at);
      w.queue.push({ type, filename, seq });
      if (w.blocked) {
        const wake = w.blocked;
        w.blocked = null;
        wake(w.queue.splice(0));
      }
    }
  };
  const kernel = { call, watch, op, onBarrier: null };
  return kernel;
}

function fsWatchOver(kernel) {
  const stat = (at) => ({ isDirectory: () => !at.endsWith('.txt'), dev: 1, ino: at.length * 31 + at.charCodeAt(at.length - 1) });
  return createFsWatch({
    process: { nextTick: (fn, ...args) => process.nextTick(fn, ...args) },
    path: path.posix,
    Buffer,
    handles: createHandleTable(),
    timers: { setImmediate: (fn) => (setImmediate(fn), {}) },
    watch: kernel.watch,
    barrier: () => kernel.call(() => (kernel.onBarrier?.(), { isDirectory: true })),
    stat,
    errno: () => -5,
    uvException: (errno, syscall) => Object.assign(new Error(syscall), { errno }),
    validatedPath: (value) => value,
    getOptions: (options) => (options && typeof options === 'object' ? options : {}),
    fs: () => null,
    StatWatcher: class {},
  });
}

async function burst(roundTrip) {
  const kernel = standInKernel(roundTrip);
  const { watch } = fsWatchOver(kernel);
  const events = [];
  const listen = (label, at) => watch(at, {}, (type, name) => events.push(`${label} ${type} ${name}`));
  const dir = listen('dir', '/r');
  const file = listen('file', '/r/c.txt');
  const marker = listen('marker', '/s');
  await new Promise((resolve) => setTimeout(resolve, 20));
  kernel.op(['/r', 'change', 'c.txt'], ['/r/c.txt', 'change', 'c.txt']);
  kernel.op(['/r', 'change', 'c.txt'], ['/r/c.txt', 'change', 'c.txt']);
  kernel.op(['/s', 'rename', '.s0']);
  const done = new Promise((resolve) => {
    marker.on('change', () => setImmediate(resolve));
  });
  await done;
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const w of [dir, file, marker]) w.close();
  return events;
}

describe('fs.watch: one queue over watches the kernel hands out apart', () => {
  const linux = ['dir change c.txt', 'file change c.txt', 'dir change c.txt', 'file change c.txt', 'marker rename .s0'];

  it('a burst comes out in the kernel order when each round trip takes a while', async () => {
    assert.deepEqual(await burst(() => 5), linux);
  });

  it('and when round trips take different times', async () => {
    let n = 0;
    assert.deepEqual(await burst(() => (n++ * 7) % 11), linux);
  });

  it('and when they are quick', async () => {
    assert.deepEqual(await burst(() => 0), linux);
  });

  it('a change made on every ask still comes out, a window at a time', async () => {
    const kernel = standInKernel(() => 0);
    const { watch } = fsWatchOver(kernel);
    const events = [];
    const w = watch('/w', {}, (type, name) => events.push(`${type} ${name}`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    let made = 0;
    kernel.onBarrier = () => {
      if (events.length === 0 && made < 1000) kernel.op(['/w', 'change', `f${made++}.txt`]);
    };
    kernel.op(['/w', 'change', `f${made++}.txt`]);
    const first = await new Promise((resolve) => w.on('change', (type, name) => resolve(name)));
    w.close();
    assert.equal(first, 'f0.txt');
    assert.ok(made < 1000, `${made} changes made before the first came out`);
  });
});

describe('fs.watch: one queue, every round trip of the kernel transport 5 ms late (kernel)', () => {
  const fixture = new URL('../golden/fixtures/fs-watch-overwrite-node22/', import.meta.url);
  let jsh;
  before(async () => {
    jsh = await withJsh({ worker: new URL('./slow-process-worker.mjs', import.meta.url) });
  });
  after(() => jsh?.close());

  it("fs-watch-overwrite-node22's rows each get their own events", async () => {
    await jsh.kernel.writeFile('/os/overwrite.js', readFileSync(new URL('script.js', fixture)));
    const r = await jsh.run(['node', 'overwrite.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, readFileSync(new URL('stdout.bin', fixture), 'utf8'));
  });

  it('a program that changes a file on every turn still hears the first change', async () => {
    await jsh.kernel.writeFile(
      '/os/busy.js',
      `const fs = require('fs');
fs.mkdirSync('busy');
let made = 0;
const w = fs.watch('busy', (type, name) => {
  w.close();
  made = Infinity;
  console.log(type, name);
});
const change = () => {
  if (made === Infinity) return;
  if (made === 1000) return console.log('nothing heard after', made, 'changes');
  fs.writeFileSync(\`busy/f\${made++}.txt\`, '');
  setImmediate(change);
};
change();
`
    );
    const r = await jsh.run(['node', 'busy.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'rename f0.txt\n');
  });
});
