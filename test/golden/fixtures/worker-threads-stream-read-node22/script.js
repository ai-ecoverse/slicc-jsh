// A ReadableStream transferred to a worker holds it while a read on it is
// pending, as in Node 22 (#624): a chunk that comes late (once the worker is
// idle) still gets there, by for await or pipeTo, before the worker ends.
// One it never reads doesn't hold it; one twice in a message stays one.
const { Worker } = require('worker_threads');
const once = (e, ev) => new Promise((r) => e.once(ev, r));
const fed = () => {
  let controller;
  const stream = new ReadableStream({ start: (c) => (controller = c) });
  return { stream, feed: () => (controller.enqueue('late'), controller.close()) };
};
const idle = "setTimeout(() => parentPort.postMessage('idle'), 0).unref(); ";
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
    ['for await', idle + "let text = ''; for await (const chunk of stream) text += chunk; parentPort.postMessage(text);"],
    ['pipeTo', idle + "let text = ''; stream.pipeTo(new WritableStream({ write(chunk) { text += chunk; } })).then(() => parentPort.postMessage(text));"],
    ['never read', idle + 'globalThis.kept = stream;'],
  ]) {
    const w = new Worker("const { parentPort } = require('worker_threads'); parentPort.once('message', async ({ stream }) => { " + body + ' });', { eval: true });
    const seen = [];
    const { stream, feed } = fed();
    w.on('message', (m) => (m === 'idle' ? feed() : seen.push('message ' + m)));
    const exited = once(w, 'exit');
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

  // A TransformStream with its readable side beside it: one stream there too.
  const both = new Worker("const { parentPort } = require('worker_threads'); parentPort.once('message', ({ t, r }) => parentPort.postMessage(String(t.readable === r)));", { eval: true });
  const bothExited = once(both, 'exit');
  const t = new TransformStream();
  both.postMessage({ t, r: t.readable }, [t]);
  console.log("a TransformStream and its readable side, one:", await once(both, 'message'));
  await bothExited;
})();
