// worker_threads parity against Node 22 (#596, #586), one step at a time.
const { Worker, MessageChannel, setEnvironmentData, receiveMessageOnPort } = require('worker_threads');
const path = require('path');
const { pathToFileURL } = require('url');
const once = (e, ev) => new Promise((r) => e.once(ev, r));
// A worker's exit, even one that came already: Node emits 'exit' right after
// the last messages it drains, before a listener added on their turn.
const exitOf = (w) => (w.threadId === -1 ? Promise.resolve() : once(w, 'exit'));
const attempt = (label, fn) => {
  try {
    const out = fn();
    console.log(label, '->', out === undefined ? 'ok' : out);
    return out;
  } catch (e) {
    console.log(label, '->', e.name, e.code ?? '', e.message);
  }
};
// An echo worker: what comes on the port it's given goes back, described.
const echoSource = `
  const { parentPort } = require('worker_threads');
  parentPort.once('message', ({ port }) => {
    port.on('message', (m) => {
      if (m === 'end') return port.close();
      const describe = (v) => v instanceof Int32Array ? 'an Int32Array of ' + v.length + (v.buffer instanceof SharedArrayBuffer ? ' on a SharedArrayBuffer' : '') : v instanceof SharedArrayBuffer ? 'a SharedArrayBuffer' : v instanceof Blob ? 'a Blob of ' + v.size : v && typeof v === 'object' && typeof v.postMessage === 'function' ? 'a port' : JSON.stringify(v);
      if (m && m.sab instanceof SharedArrayBuffer) new Int32Array(m.sab)[0] = 42;
      if (m && m.view instanceof Int32Array && m.view.buffer instanceof SharedArrayBuffer) m.view[1] = 7;
      port.postMessage(Object.entries(m && typeof m === 'object' ? m : { value: m }).map(([k, v]) => k + ': ' + describe(v)).join(', '));
    });
  });
`;
(async () => {
  console.log('preloaded in the main thread:', globalThis.preloaded);

  // execArgv a worker refuses (#596 items 2 and 10).
  for (const execArgv of [['--max-old-space-size=64'], ['--title=x'], ['--title', 'x', '--bogus'], ['--bogus', '--title', 'x'], ['--stack-trace-limit=5'], ['--stack-trace-limit'], ['--max-old-space-size'], ['--report-compact'], ['--no-report-compact'], ['--trace-sigint'], ['-v'], ['--version'], ['-h'], ['-e'], ['--eval'], ['-pe'], ['-e', '--bogus'], ['--bogus', '-e'], ['--eval='], ['--require'], ['--bogus', '--require'], ['-p'], ['-c'], ['--require', path.join(__dirname, 'other.js'), '--no-warnings']]) {
    attempt('execArgv ' + JSON.stringify(execArgv).replace(__dirname, '.'), () => {
      const w = new Worker('0', { eval: true, execArgv, stdout: true, stderr: true });
      w.terminate();
    });
  }

  // NODE_OPTIONS (#596 item 1): the parent's, inherited; an env's own, checked.
  const report = path.join(__dirname, 'report.js');
  for (const [label, env] of [
    ['the parent env', undefined],
    ['an env with -r', { NODE_OPTIONS: '--require ' + path.join(__dirname, 'other.js') }],
    ['an env without', {}],
  ]) {
    const w = new Worker(report, env ? { env } : {});
    console.log('NODE_OPTIONS from', label, '->', await once(w, 'message'));
    await exitOf(w);
  }
  for (const NODE_OPTIONS of ['--title=x', '--bogus', '--max-old-space-size=64']) {
    attempt('an env with NODE_OPTIONS ' + NODE_OPTIONS, () => new Worker(report, { env: { NODE_OPTIONS } }).terminate() && undefined);
  }

  // threadId: -1 from its 'exit' on.
  const counted = new Worker('0', { eval: true });
  const before = counted.threadId > 0;
  const inExit = await new Promise((resolve) => counted.on('exit', () => resolve(counted.threadId)));
  console.log('threadId before exit is positive:', before, 'in its exit:', inExit);

  // Environment data that can't be cloned (#596 item 4).
  setEnvironmentData('f', () => {});
  attempt('environment data with a function', () => new Worker('0', { eval: true }).terminate() && undefined);
  setEnvironmentData('f', undefined);

  // String data: and file: filenames (#596 item 7).
  attempt('a data: string', () => new Worker('data:text/javascript,0') && undefined);
  attempt('a file:// string', () => new Worker('file:///nowhere.js') && undefined);

  // A file: URL's query and fragment (#596 item 8: Node 22 drops them).
  for (const suffix of ['?variant=1', '#frag']) {
    const w = new Worker(new URL(pathToFileURL(path.join(__dirname, 'm.mjs')).href + suffix));
    console.log('a file: URL with', suffix, '-> import.meta.url search+hash|file:', await once(w, 'message'));
    await exitOf(w);
  }

  // A stream in workerData, listed (#596 item 5).
  const stream = new ReadableStream({ start(c) { c.enqueue('streamed'); c.close(); } });
  const reader = new Worker("const { workerData, parentPort } = require('worker_threads'); workerData.s.getReader().read().then(({ value }) => parentPort.postMessage(value));", { eval: true, workerData: { s: stream }, transferList: [stream] });
  console.log('a stream in workerData:', await once(reader, 'message'));
  await exitOf(reader);

  // Messages to another thread: getters read once whichever way it goes
  // (#596 items 3, 6, 9), and what the platform shares or clones.
  const echo = new Worker(echoSource, { eval: true });
  const { port1: here, port2: there } = new MessageChannel();
  echo.postMessage({ port: there }, [there]);
  const ask = async (label, message, transfer) => {
    try {
      here.postMessage(message, transfer);
    } catch (e) {
      console.log(label, '->', e.name, e.message);
      return;
    }
    console.log(label, '->', await once(here, 'message'));
  };
  let reads = 0;
  const getter = () => ({ get value() { reads += 1; return 'read'; } });
  const sab = new SharedArrayBuffer(4);
  await ask('a getter and a SharedArrayBuffer', Object.assign(getter(), { sab }));
  console.log('  getter reads:', reads, 'the worker wrote:', new Int32Array(sab)[0]);
  const shared = new SharedArrayBuffer(16);
  await ask('a view of a SharedArrayBuffer', { view: new Int32Array(shared, 4, 2) });
  console.log('  the worker wrote:', new Int32Array(shared)[2]);
  reads = 0;
  await ask('a getter and a Blob', Object.assign(getter(), { blob: new Blob(['four']) }));
  console.log('  getter reads:', reads);
  reads = 0;
  await ask('a getter and 2 MB', Object.assign(getter(), { big: 'x'.repeat(2 << 20).length }));
  console.log('  getter reads:', reads);
  reads = 0;
  await ask('a getter that throws a DataCloneError of its own', { get value() { reads += 1; throw new DOMException('mine', 'DataCloneError'); } });
  console.log('  getter reads:', reads);
  reads = 0;
  class Holder { constructor() { this.n = 1; } get value() { reads += 1; return 'read'; } }
  Object.defineProperty(Holder.prototype, 'value', { enumerable: true });
  const holder = new Holder();
  Object.defineProperty(holder, 'own', { enumerable: true, get() { reads += 1; return 'own'; } });
  const { port1: carried } = new MessageChannel();
  await ask('a class instance with a getter, and a port', { holder, carried }, [carried]);
  console.log('  getter reads:', reads);

  // Ports (#586): moved within the thread, duplicated, unlisted, closed.
  const { port1: moved } = new MessageChannel();
  const { port2: holderPort } = new MessageChannel();
  holderPort.postMessage(null, [moved]);
  attempt('a Worker with a port moved within the thread', () => new Worker('0', { eval: true, workerData: { p: moved }, transferList: [moved] }) && undefined);
  attempt('a post with a port moved within the thread', () => here.postMessage({ p: moved }, [moved]));
  const { port1: dup } = new MessageChannel();
  attempt('a Worker with a duplicate port', () => new Worker('0', { eval: true, workerData: { a: dup }, transferList: [dup, dup] }) && undefined);
  attempt('a post with a duplicate port', () => here.postMessage({ a: dup }, [dup, dup]));
  const { port1: unlisted } = new MessageChannel();
  attempt('a Worker with an unlisted port', () => new Worker('0', { eval: true, workerData: { a: unlisted } }) && undefined);
  attempt('a post (other thread) with an unlisted port', () => here.postMessage({ a: unlisted }));
  const local = new MessageChannel();
  attempt('a post (this thread) with an unlisted port', () => local.port1.postMessage({ a: unlisted }));
  const { port1: listed, port2: alsoUnlisted } = new MessageChannel();
  attempt('a post with one port listed and one not', () => here.postMessage({ listed, alsoUnlisted }, [listed]));
  const { port1: shut } = new MessageChannel();
  shut.close();
  attempt('a Worker with a closed port', () => new Worker('0', { eval: true, workerData: { a: shut }, transferList: [shut] }) && undefined);
  attempt('a post with a closed port', () => here.postMessage({ a: shut }, [shut]));
  const { port1: inMap } = new MessageChannel();
  const { port1: asKey } = new MessageChannel();
  const { port1: inSet } = new MessageChannel();
  const circular = { inMap: new Map([['p', inMap]]), byKey: new Map([[asKey, 1]]), inSet: new Set([inSet]) };
  circular.self = circular;
  local.port1.postMessage(circular, [inMap, asKey, inSet]);
  const nested = await once(local.port2, 'message');
  console.log('ports in a Map, as a Map key and in a Set, in this thread:', [nested.inMap.get('p'), [...nested.byKey.keys()][0], [...nested.inSet][0]].map((p) => typeof p.postMessage).join(' '), nested.self === nested);
  const unlistedStream = new ReadableStream();
  attempt('a post (other thread) with an unlisted stream', () => here.postMessage({ s: unlistedStream }));
  attempt('a Worker with an unlisted stream', () => new Worker('0', { eval: true, workerData: { s: unlistedStream } }) && undefined);
  local.port1.postMessage({ blob: new Blob(['local']) });
  console.log('a Blob through a port in this thread:', (await once(local.port2, 'message')).blob.size);
  local.port1.close();
  local.port2.close();

  // A post through a port whose other end closed still moves its buffers.
  const { port1: gone, port2: goneThere } = new MessageChannel();
  const closer = new Worker("require('worker_threads').parentPort.once('message', ({ port }) => port.close());", { eval: true });
  closer.postMessage({ port: goneThere }, [goneThere]);
  gone.on('message', () => {});
  await once(gone, 'close');
  await exitOf(closer);
  const buf = new ArrayBuffer(8);
  gone.postMessage(buf, [buf]);
  console.log('a buffer posted through a closed port, its byteLength after:', buf.byteLength);

  // A forged port mark stays data, whatever the random source says (#586).
  const realUUID = crypto.randomUUID;
  const realRandom = Math.random;
  crypto.randomUUID = () => '00000000-0000-4000-8000-000000000000';
  Math.random = () => 0;
  const { port1: real } = new MessageChannel();
  const forged = {};
  for (const key of ['\u0000slicc-jsh port', 'slicc-jsh port']) forged[key] = '00000000-0000-4000-8000-000000000000:0';
  await ask('a forged mark beside a real port', { real, forged }, [real]);
  crypto.randomUUID = realUUID;
  Math.random = realRandom;

  here.postMessage('end');
  await exitOf(echo);
})();
process.on('exit', () => console.log('the program ends'));
