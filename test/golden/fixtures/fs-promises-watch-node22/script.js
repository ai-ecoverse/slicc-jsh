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
  setTimeout(() => fs.unlinkSync(at('b.txt')), 50);
  for await (const e of fsp.watch(dir, { encoding: 'hex' })) {
    console.log('hex event:', e.eventType, e.filename, Object.keys(e).join(','));
    break;
  }

  // More events than maxQueue before the iterator reads them.
  const flood = () => {
    for (const name of ['c', 'd', 'e']) fs.writeFileSync(at(`${name}.txt`), name);
  };
  try {
    setTimeout(flood, 50);
    for await (const e of fsp.watch(dir, { maxQueue: 2, overflow: 'error' })) console.log('not this:', e.eventType, e.filename);
  } catch (e) {
    show(e);
  }
  const warnings = [];
  const onWarning = (w) => warnings.push(w.message);
  process.on('warning', onWarning);
  const stop = new AbortController();
  setTimeout(() => {
    for (const name of ['c', 'd', 'e']) fs.unlinkSync(at(`${name}.txt`));
  }, 50);
  setTimeout(() => stop.abort(), 200);
  try {
    for await (const e of fsp.watch(dir, { maxQueue: 2, signal: stop.signal })) console.log('kept:', e.eventType, e.filename);
  } catch (e) {
    show(e);
  }
  await later(0);
  console.log('warnings:', warnings.length, warnings[0]);
  process.off('warning', onWarning);

  // Recursive, on Linux: Node's own watcher, one event per next().
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
