// fs.promises.watch, as Node 22 has it on Linux: an async iterator of
// { eventType, filename }; an AbortSignal ends it with an AbortError;
// maxQueue with overflow 'error' throws, with 'ignore' it warns. The
// program makes the changes itself, after the iterator has started.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-p-'));
const at = (...names) => path.join(dir, ...names);
const hide = (s) => String(s).split(dir).join('<dir>');
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const show = (e) => console.log(e.name, e.code, hide(e.message), e.syscall ?? '', hide(e.path ?? ''));

// A section that waits forever says which, rather than timing out silently.
let section = 'events until aborted';
setTimeout(() => {
  console.log('stuck in', section);
  process.exit(1);
}, 10000).unref();

async function main() {
  console.log('same function:', fsp.watch === fs.promises.watch);

  // Events, until an AbortSignal ends it.
  const ac = new AbortController();
  const it = fsp.watch(dir, { signal: ac.signal });
  console.log('iterator:', typeof it.next, typeof it[Symbol.asyncIterator]);
  const changes = (async () => {
    setTimeout(() => fs.writeFileSync(at('a.txt'), 'a'), 50);
    setTimeout(() => fs.appendFileSync(at('a.txt'), 'b'), 150);
    setTimeout(() => fs.renameSync(at('a.txt'), at('b.txt')), 250);
    setTimeout(() => ac.abort(), 350);
  })();
  try {
    for await (const { eventType, filename } of it) console.log('event:', eventType, filename);
  } catch (e) {
    show(e);
  }
  await changes;

  // Another encoding, and `break` ends it.
  section = 'hex';
  setTimeout(() => fs.unlinkSync(at('b.txt')), 50);
  for await (const e of fsp.watch(dir, { encoding: 'hex' })) {
    console.log('hex event:', e.eventType, e.filename, Object.keys(e).join(','));
    break;
  }

  // More events than maxQueue before the iterator reads them: after the
  // first event, the program pauses while it makes more. Each case has a
  // directory of its own: two watches of one directory share libuv's.
  section = 'overflow error';
  fs.mkdirSync(at('e'));
  const flooded = fsp.watch(at('e'), { maxQueue: 2, overflow: 'error' });
  const firstFlooded = flooded.next();
  fs.writeFileSync(at('e', 't.txt'), 't');
  console.log('first:', (await firstFlooded).value.filename);
  for (const name of ['c', 'd', 'e']) fs.writeFileSync(at('e', `${name}.txt`), name);
  await later(100);
  try {
    const e = (await flooded.next()).value;
    console.log('not this:', e.eventType, e.filename);
  } catch (e) {
    show(e);
  }
  section = 'overflow ignore';
  const warnings = [];
  const onWarning = (w) => warnings.push(w.message);
  process.on('warning', onWarning);
  fs.mkdirSync(at('i'));
  const stop = new AbortController();
  const kept = fsp.watch(at('i'), { maxQueue: 2, signal: stop.signal });
  const firstKept = kept.next();
  fs.writeFileSync(at('i', 'u.txt'), 'u');
  console.log('first:', (await firstKept).value.filename);
  for (const name of ['v', 'w']) fs.writeFileSync(at('i', `${name}.txt`), name);
  await later(100);
  setTimeout(() => stop.abort(), 100);
  try {
    for (;;) {
      const e = (await kept.next()).value;
      console.log('kept:', e.eventType, e.filename);
    }
  } catch (e) {
    show(e);
  }
  await later(0);
  console.log('warnings:', warnings.length, warnings[0]);
  process.off('warning', onWarning);

  // Recursive, on Linux: Node's own watcher, one event per next().
  section = 'recursive';
  fs.mkdirSync(at('sub'));
  const rec = new AbortController();
  setTimeout(() => fs.writeFileSync(at('sub', 's.txt'), 's'), 50);
  try {
    for await (const e of fsp.watch(dir, { recursive: true, signal: rec.signal })) {
      console.log('recursive:', e.eventType, e.filename);
      rec.abort();
    }
  } catch (e) {
    show(e);
  }

  // Errors: thrown by the first next().
  section = 'errors';
  const first = async (...args) => {
    try {
      await fsp.watch(...args).next();
      console.log('no error');
    } catch (e) {
      show(e);
    }
  };
  await first(at('missing'));
  await first(at('missing'), { recursive: true });
  await first(42);
  await first(dir, 'utf8');
  await first(dir, { overflow: 'throw' });
  await first(dir, { maxQueue: 1.5 });
  await first(dir, { encoding: 'nope' });
  // Node 22 checks Buffer.isEncoding, which 'buffer' is not.
  await first(dir, { encoding: 'buffer' });
  await first(dir, { signal: AbortSignal.abort() });
}
main();
