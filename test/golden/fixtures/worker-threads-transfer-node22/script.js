// worker_threads' cloning and transfers against Node 22, one step at a time:
// an argv element that throws throws from the constructor (and leaves the
// program free to end); a duplicate ArrayBuffer in a transfer list is a
// DataCloneError, the buffer still whole and the worker never getting the
// message; a post that can't be cloned leaves the ports in its transfer
// list usable; a port inside a Map arrives as a port; and a data: URL worker
// runs as that URL.
const { Worker, MessageChannel } = require('worker_threads');
const once = (w, ev) => new Promise((r) => w.once(ev, r));
(async () => {
  try {
    new Worker('0', { eval: true, argv: [{ toString() { throw new Error('argv boom'); } }] });
    console.log('constructed');
  } catch (e) {
    console.log('an argv element that throws:', e.message);
  }

  const echo = new Worker(
    "const { parentPort } = require('worker_threads'); parentPort.on('message', (m) => parentPort.postMessage(m instanceof Map ? 'a Map with a ' + (typeof m.get('port')?.postMessage === 'function' ? 'port' : 'no port') : typeof m === 'string' ? m : 'an object'));",
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

  const { port1: inMap } = new MessageChannel();
  echo.postMessage(new Map([['port', inMap]]), [inMap]);
  console.log('a port inside a Map:', await next());
  await echo.terminate();

  const src = "import { parentPort } from 'node:worker_threads'; parentPort.postMessage(import.meta.url.slice(0, 35));";
  const fromUrl = new Worker(new URL('data:text/javascript,' + encodeURIComponent(src)));
  console.log('a data: URL worker, import.meta.url:', await once(fromUrl, 'message'));
  await once(fromUrl, 'exit');
})();
process.on('exit', () => console.log('the program ends'));
