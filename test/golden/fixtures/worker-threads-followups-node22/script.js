// worker_threads against Node 22 (#628): a post in this thread runs neither
// a Map's and a Set's own iterator, set and add (structured clone reads
// their entries) nor the program's Reflect.apply or Array.from; and a
// Worker's threadId is its id in its last message, -1 from its 'exit' on.
const { Worker, MessageChannel } = require('worker_threads');
const once = (e, ev) => new Promise((r) => e.once(ev, r));
(async () => {
  // Its last messages: one through the mailbox, and one with a port (the
  // platform's way), the worker exiting right after.
  for (const code of [
    "require('worker_threads').parentPort.postMessage('last')",
    "const { parentPort, MessageChannel } = require('worker_threads'); const { port1 } = new MessageChannel(); parentPort.postMessage({ port1 }, [port1]); process.exit(0);",
  ]) {
    const w = new Worker(code, { eval: true });
    const ids = [];
    w.on('message', () => ids.push(w.threadId > 0));
    await once(w, 'exit');
    console.log('threadId positive in its last message:', ids.join(), 'and in its exit:', w.threadId);
  }

  const local = new MessageChannel();
  const { port1: p } = new MessageChannel();
  const m = new Map([['p', p]]);
  m[Symbol.iterator] = () => {
    throw new Error('its iterator');
  };
  m.set = () => {
    throw new Error('its set');
  };
  const s = new Set([1, 2]);
  s[Symbol.iterator] = () => {
    throw new Error('its iterator');
  };
  s.add = () => {
    throw new Error('its add');
  };
  // And with Reflect.apply and Array.from the program's own.
  const realApply = Reflect.apply;
  const realFrom = Array.from;
  Reflect.apply = () => {
    throw new Error('its Reflect.apply');
  };
  Array.from = () => {
    throw new Error('its Array.from');
  };
  try {
    local.port1.postMessage({ m, s }, [p]);
  } finally {
    Reflect.apply = realApply;
    Array.from = realFrom;
  }
  const got = await once(local.port2, 'message');
  console.log('a Map and a Set with their own iterator, set and add:', typeof got.m.get('p').postMessage, [...Set.prototype.values.call(got.s)].join());
  local.port1.close();
})();
