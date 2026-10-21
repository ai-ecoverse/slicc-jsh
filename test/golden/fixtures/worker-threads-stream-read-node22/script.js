// A ReadableStream transferred to a worker holds it while a read on it is
// pending, as in Node 22 (#624): a chunk that comes late (from the parent's
// timer) still gets there, by for await or pipeTo, before the worker ends.
// One it never reads doesn't hold it.
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
})();
