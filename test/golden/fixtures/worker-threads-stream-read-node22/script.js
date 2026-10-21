// A ReadableStream transferred to a worker holds it while a read on it is
// pending, as in Node 22 (#624): a chunk that comes late (from the parent's
// timer) still gets there, by for await or pipeTo, before the worker ends.
// One it never reads doesn't hold it; one twice in a message stays one.
const { Worker } = require('worker_threads');
const once = (e, ev) => new Promise((r) => e.once(ev, r));
const late = (ms) =>
  new ReadableStream({
    start(c) {
      setTimeout(() => {
        c.enqueue('late');
        c.close();
      }, ms);
    },
  });
(async () => {
  for (const [label, body] of [
    ['for await', "let text = ''; for await (const chunk of stream) text += chunk; parentPort.postMessage(text);"],
    ['pipeTo', "let text = ''; stream.pipeTo(new WritableStream({ write(chunk) { text += chunk; } })).then(() => parentPort.postMessage(text));"],
    ['never read', 'globalThis.kept = stream;'],
  ]) {
    const w = new Worker("const { parentPort } = require('worker_threads'); parentPort.once('message', async ({ stream }) => { " + body + ' });', { eval: true });
    const seen = [];
    w.on('message', (m) => seen.push('message ' + m));
    const exited = once(w, 'exit');
    const stream = late(300);
    w.postMessage({ stream }, [stream]);
    await exited;
    console.log(label + ':', seen.join(' ') || 'no message', '| exit');
  }

  // One stream twice in a message is one stream there, even in a worker
  // that has replaced its global ReadableStream.
  const w = new Worker(
    "const { parentPort } = require('worker_threads'); const Saved = ReadableStream; globalThis.ReadableStream = undefined; parentPort.once('message', async ({ a, b }) => { let text = ''; for await (const chunk of a) text += chunk; parentPort.postMessage([a === b, a instanceof Saved, text].join(' ')); });",
    { eval: true }
  );
  const exited = once(w, 'exit');
  const twice = late(10);
  w.postMessage({ a: twice, b: twice }, [twice]);
  console.log('a stream twice, the global gone:', await once(w, 'message'));
  await exited;
})();
