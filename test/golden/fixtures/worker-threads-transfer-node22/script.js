// worker_threads' cloning and transfers against Node 22, one step at a time:
// an argv element that throws throws from the constructor (and leaves the
// program free to end); a duplicate ArrayBuffer in a transfer list is a
// DataCloneError, the buffer still whole and the worker never getting the
// message; a post that can't be cloned leaves the ports in its transfer
// list usable, as does one whose transfer list has a port and a duplicate
// ArrayBuffer; a port inside a Map arrives as a port; a port forwarded on
// from one worker to another gets every later message; workerData's getters
// run once, in the constructor; a data: URL worker runs as that URL, with
// no [worker eval] in its argv; invalid execArgv flags throw from the
// constructor; a port in an Error's cause arrives as a port; a getter that
// throws makes the post throw, once, and sends nothing; and a getter that
// detaches a listed buffer leaves the post standing; and a transfer list
// with something that can't be transferred ({}, a SharedArrayBuffer) is a
// DataCloneError that leaves the ports in it usable, a fake port (a forged
// tag) too; and a stream posted, with its transfer, before the worker has
// started gets there.
const { Worker, MessageChannel } = require('worker_threads');
const once = (w, ev) => new Promise((r) => w.once(ev, r));
(async () => {
  try {
    new Worker('0', { eval: true, execArgv: ['--no-warnings', '--bogus-one', '--bogus-two'] });
    console.log('constructed');
  } catch (e) {
    console.log('invalid execArgv flags:', e.code, e.message);
  }
  try {
    new Worker('0', { eval: true, argv: [{ toString() { throw new Error('argv boom'); } }] });
    console.log('constructed');
  } catch (e) {
    console.log('an argv element that throws:', e.message);
  }

  const echo = new Worker(
    "const { parentPort } = require('worker_threads'); parentPort.on('message', (m) => parentPort.postMessage(m?.err instanceof Error ? m.err.constructor.name + ' ' + m.err.message + ', its cause a ' + (typeof m.err.cause?.postMessage === 'function' ? 'port' : 'non-port') : m instanceof Map ? 'a Map with a ' + (typeof m.get('port')?.postMessage === 'function' ? 'port' : 'no port') : typeof m === 'string' ? m : 'an object'));",
    { eval: true }
  );
  await once(echo, 'online');
  const next = () => once(echo, 'message');

  const buf = new ArrayBuffer(8);
  try {
    echo.postMessage({ buf }, [buf, buf]);
    console.log('posted');
  } catch (e) {
    console.log('a duplicate ArrayBuffer:', e.name, e.message, '| its byteLength:', buf.byteLength);
  }
  echo.postMessage('after the duplicate');
  console.log('the worker got:', await next());

  const { port1, port2 } = new MessageChannel();
  try {
    echo.postMessage(() => {}, [port1]);
    console.log('posted');
  } catch (e) {
    console.log('a post that cannot be cloned:', e.name);
  }
  const hello = once(port2, 'message');
  port1.postMessage('hello');
  console.log('its port still works:', await hello);
  port1.close();
  port2.close();

  const { port1: kept, port2: keptPeer } = new MessageChannel();
  const dup = new ArrayBuffer(4);
  try {
    echo.postMessage({ kept }, [kept, dup, dup]);
    console.log('posted');
  } catch (e) {
    console.log('a port and a duplicate ArrayBuffer:', e.name, e.message);
  }
  const hi = once(keptPeer, 'message');
  kept.postMessage('hi');
  console.log('that port still works:', await hi);
  kept.close();
  keptPeer.close();

  const { port1: withJunk, port2: withJunkPeer } = new MessageChannel();
  for (const junk of [{}, new SharedArrayBuffer(4)]) {
    try {
      echo.postMessage({ withJunk }, [withJunk, junk]);
      console.log('posted');
    } catch (e) {
      console.log('a transfer list with', Object.prototype.toString.call(junk) + ':', e.name, e.message);
    }
  }
  try {
    echo.postMessage({ withJunk }, [withJunk, { [Symbol.toStringTag]: 'MessagePort' }]);
    console.log('posted');
  } catch (e) {
    console.log('a transfer list with a fake port:', e.name, e.message);
  }
  const junkHi = once(withJunkPeer, 'message');
  withJunk.postMessage('still here');
  console.log('its port:', await junkHi);
  withJunk.close();
  withJunkPeer.close();

  const reader = new Worker(
    "const { parentPort } = require('worker_threads'); parentPort.once('message', async ({ stream }) => { let text = ''; for await (const chunk of stream) text += chunk; parentPort.postMessage(text); });",
    { eval: true }
  );
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue('a stream ');
      controller.enqueue('posted early');
      controller.close();
    },
  });
  reader.postMessage({ stream }, [stream]);
  console.log('a stream posted before the worker started:', await once(reader, 'message'));
  await reader.terminate();

  const { port1: inCause } = new MessageChannel();
  echo.postMessage({ err: new TypeError('with a port', { cause: inCause }) }, [inCause]);
  console.log('an Error whose cause is a port:', await next());

  let throwReads = 0;
  const throwsOnce = { get v() { throwReads += 1; if (throwReads === 1) throw new Error('first read'); return 'later'; } };
  try {
    echo.postMessage(throwsOnce);
    console.log('posted');
  } catch (e) {
    console.log('a getter that throws once:', e.message, '| reads:', throwReads);
  }
  echo.postMessage('after the throwing getter');
  console.log('the worker got:', await next());

  const listed = new ArrayBuffer(4);
  const detaches = { get v() { structuredClone(listed, { transfer: [listed] }); return 1; } };
  try {
    echo.postMessage(detaches, [listed]);
    console.log('a getter that detaches a listed buffer: posted');
  } catch (e) {
    console.log('a getter that detaches a listed buffer:', e.name, e.message);
  }
  console.log('the worker got:', await next());

  const { port1: inMap } = new MessageChannel();
  echo.postMessage(new Map([['port', inMap]]), [inMap]);
  console.log('a port inside a Map:', await next());
  await echo.terminate();

  // A port goes to worker A, which hands it back; it goes on to worker B,
  // which must get every message sent on its other end after that.
  const a = new Worker("const { parentPort } = require('worker_threads'); parentPort.once('message', ({ port }) => { port.on('message', () => {}); parentPort.postMessage({ port }, [port]); });", { eval: true });
  const b = new Worker("const { parentPort } = require('worker_threads'); parentPort.once('message', ({ port }) => { const got = []; port.on('message', (m) => { got.push(m); if (got.length === 3) { parentPort.postMessage(got.join(' ')); port.close(); } }); parentPort.postMessage('ready'); });", { eval: true });
  const { port1: sender, port2: forwarded } = new MessageChannel();
  a.postMessage({ port: forwarded }, [forwarded]);
  const { port: back } = await once(a, 'message');
  b.postMessage({ port: back }, [back]);
  await once(b, 'message');
  const all = once(b, 'message');
  for (const m of ['m1', 'm2', 'm3']) sender.postMessage(m);
  console.log('a port forwarded on to another worker got:', await all);
  sender.close();
  await a.terminate();
  await b.terminate();

  let reads = 0;
  const getters = { get value() { reads += 1; return 'read ' + reads; } };
  const g = new Worker("const { workerData, parentPort } = require('worker_threads'); parentPort.postMessage(workerData.value)", { eval: true, workerData: getters });
  console.log('getter reads after the constructor:', reads);
  console.log('the worker got:', await once(g, 'message'));
  await once(g, 'exit');
  console.log('getter reads in all:', reads);

  const src = "import { parentPort } from 'node:worker_threads'; parentPort.postMessage(import.meta.url.slice(0, 35) + ' ' + JSON.stringify(process.argv.slice(1)));";
  const fromUrl = new Worker(new URL('data:text/javascript,' + encodeURIComponent(src)), { argv: ['x', 'y'] });
  console.log('a data: URL worker, import.meta.url and argv:', await once(fromUrl, 'message'));
  await once(fromUrl, 'exit');
})();
process.on('exit', () => console.log('the program ends'));
