// stream.finished() and its kin on the program's web streams (#1270): how
// each kind of end is reported, as Node 22 reports it. Each stream is read
// (or written) to its end while finished() waits, since Node's readable ends
// only once its last chunk is read.
import { addAbortSignal, finished } from 'node:stream';
import { finished as finishedP } from 'node:stream/promises';
import * as web from 'node:stream/web';

const kClosed = Symbol.for('nodejs.webstream.isClosedPromise');
const kError = Symbol.for('nodejs.webstream.controllerErrorFunction');
const ended = (stream) =>
  new Promise((resolve) => finished(stream, (err) => resolve(err ? `error ${err.name}: ${err.message}` : 'finished')));
const drain = async (stream) => {
  const reader = stream.getReader();
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return `read ${chunks.join('')}`;
      chunks.push(typeof value === 'string' ? value : new TextDecoder().decode(value));
    }
  } catch (err) {
    return `read failed ${err.name}: ${err.message}`;
  }
};
const readable = async (label, make) => {
  const stream = make();
  const [end, read] = await Promise.all([ended(stream), drain(stream)]);
  console.log(`readable ${label}: ${end}; ${read}`);
};
const writable = async (label, make, use) => {
  const stream = make();
  const writer = stream.getWriter();
  const [end, used] = await Promise.all([ended(stream), use(writer).then(() => 'ok', (err) => `failed ${err.name}: ${err.message}`)]);
  console.log(`writable ${label}: ${end}; ${used}`);
};

const rs = new ReadableStream();
console.log('hooks', typeof rs[kClosed]?.promise?.then, typeof rs[kError], typeof new WritableStream()[kClosed]?.promise?.then);
console.log(
  'identity',
  rs instanceof ReadableStream,
  new WritableStream() instanceof WritableStream,
  new Response('body').body instanceof ReadableStream,
  ReadableStream.prototype.constructor === ReadableStream,
  WritableStream.prototype.constructor === WritableStream,
  web.ReadableStream === ReadableStream,
  web.WritableStream === WritableStream,
  ReadableStream.name,
  ReadableStream.length,
  WritableStream.name,
  WritableStream.length,
);
try {
  ReadableStream();
} catch (err) {
  console.log('call without new', err instanceof TypeError);
}
try {
  new ReadableStream({ pull: 5 });
} catch (err) {
  console.log('bad pull', err instanceof TypeError);
}
try {
  new ReadableStream({
    start() {
      throw new Error('start threw');
    },
  });
} catch (err) {
  console.log('start threw', err.message);
}

await readable('closed', () => new ReadableStream({ start(c) { c.enqueue('a'); c.enqueue('b'); c.close(); } }));
await readable('closed later', () => new ReadableStream({ start(c) { setTimeout(() => { c.enqueue('late'); c.close(); }, 20); } }));
await readable('pulled', () => {
  let n = 0;
  return new ReadableStream({ pull(c) { if (++n > 3) c.close(); else c.enqueue(String(n)); } });
});
await readable('controller error', () => new ReadableStream({ start(c) { c.error(new Error('boom')); } }));
await readable('start rejects', () => new ReadableStream({ start() { return Promise.reject(new RangeError('no start')); } }));
await readable('pull rejects', () => new ReadableStream({ async pull() { throw new Error('no pull'); } }));
await readable('pull throws', () => new ReadableStream({ pull() { throw new Error('pull threw'); } }));
await readable('size throws', () =>
  new ReadableStream(
    { start(c) { try { c.enqueue('x'); } catch (err) { console.log('enqueue threw', err.message); } } },
    { size() { throw new Error('bad size'); } },
  ),
);
await readable('bytes', () => new ReadableStream({ type: 'bytes', start(c) { c.enqueue(new TextEncoder().encode('xyz')); c.close(); } }));
await readable('bytes error', () => new ReadableStream({ type: 'bytes', start(c) { c.error(new TypeError('byte boom')); } }));

{
  const stream = new ReadableStream({ cancel(reason) { console.log('source cancel', reason); } });
  const end = ended(stream);
  await stream.cancel('enough');
  console.log('readable canceled:', await end);
}
{
  const ac = new AbortController();
  const stream = addAbortSignal(ac.signal, new ReadableStream({ pull() {} }));
  const both = Promise.all([ended(stream), drain(stream)]);
  ac.abort();
  console.log('readable aborted:', (await both).join('; '));
}
{
  const stream = new ReadableStream({ start(c) { c.enqueue('p'); c.close(); } });
  const [, read] = await Promise.all([finishedP(stream), drain(stream)]);
  console.log('promises.finished readable:', read);
  const failing = new ReadableStream({ start(c) { c.error(new Error('promised boom')); } });
  console.log('promises.finished errored:', await finishedP(failing).then(() => 'resolved', (err) => err.message));
}
{
  class Mine extends ReadableStream {
    get mine() {
      return true;
    }
  }
  const stream = new Mine({ start(c) { c.enqueue('m'); c.close(); } });
  const [end, read] = await Promise.all([ended(stream), drain(stream)]);
  console.log('subclass', stream instanceof Mine, stream instanceof ReadableStream, stream.mine, end, read);
}

const got = [];
await writable('closed', () => new WritableStream({ write(chunk) { got.push(chunk); } }), async (w) => { await w.write('a'); await w.close(); });
console.log('written', got.join(''));
await writable('closed by sink', () => new WritableStream({ close() { return new Promise((r) => setTimeout(r, 20)); } }), (w) => w.close());
await writable('write rejects', () => new WritableStream({ write() { return Promise.reject(new Error('no write')); } }), (w) => w.write('x'));
await writable('write throws', () => new WritableStream({ write() { throw new Error('write threw'); } }), (w) => w.write('x'));
await writable('close rejects', () => new WritableStream({ close() { throw new Error('no close'); } }), (w) => w.close());
await writable('aborted', () => new WritableStream({ abort(reason) { console.log('sink abort', reason.message); } }), (w) => w.abort(new Error('stop')));
await writable('aborted, no sink abort', () => new WritableStream(), (w) => w.abort(new Error('halt')));
await writable('controller error', () => new WritableStream({ start(c) { c.error(new Error('werr')); } }), (w) => w.write('x'));
await writable('start rejects', () => new WritableStream({ start() { return Promise.reject(new Error('no wstart')); } }), (w) => w.write('x'));
{
  const ac = new AbortController();
  const stream = addAbortSignal(ac.signal, new WritableStream());
  const end = ended(stream);
  ac.abort();
  console.log('writable aborted by signal:', await end);
}
{
  const stream = new WritableStream();
  const writer = stream.getWriter();
  const [, closed] = await Promise.all([finishedP(stream), writer.close().then(() => 'closed')]);
  console.log('promises.finished writable:', closed);
}
