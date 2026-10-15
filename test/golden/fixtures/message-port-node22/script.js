// Node 22's MessageChannel / MessagePort, in-process (#215): construction,
// postMessage errors and transfers, onmessage starting the port, close() on
// both ends after what was posted, hasRef, receiveMessageOnPort, inspect.
const { MessageChannel, MessagePort, receiveMessageOnPort } = require('worker_threads');
const L = [];
try { new MessagePort(); } catch (e) { L.push(`new MessagePort: ${e.name} ${e.code} ${e.message}`); }
const { port1, port2 } = new MessageChannel();
port2.onmessage = (e) => L.push(`p2 ${JSON.stringify(e.data)} ports=${e.ports.length} ${e.constructor.name} target=${e.target === port2}`);
port1.addEventListener('close', () => L.push('p1 close'));
port2.addEventListener('close', () => L.push('p2 close'));
port1.postMessage('a');
port1.postMessage({ n: 1 });
try { port1.postMessage(() => {}); } catch (e) { L.push(`clone ${e.name} ${e.code}`); }
try { port1.postMessage(); } catch (e) { L.push(`missing ${e.name} ${e.code} ${e.message}`); }
const ab = new ArrayBuffer(8);
port1.postMessage(ab, [ab]);
L.push(`ab after transfer ${ab.byteLength}`);
const mc = new MessageChannel();
port1.postMessage({ p: mc.port1 }, [mc.port1]);
port1.close();
L.push(`after close sync; hasRef p2 ${port2.hasRef()}`);
try { port1.postMessage('after close'); L.push('post after close ok'); } catch (e) { L.push(`post after close ${e.code}`); }
setTimeout(() => {
  console.log(L.join('\n'));
  const c = new MessageChannel();
  c.port1.postMessage('q1'); c.port1.postMessage('q2');
  console.log('receive', JSON.stringify(receiveMessageOnPort(c.port2)), JSON.stringify(receiveMessageOnPort(c.port2)), receiveMessageOnPort(c.port2));
  console.log('unstarted hasRef', c.port2.hasRef(), 'with listener', (c.port2.on('message', () => {}), c.port2.hasRef()), 'unref', (c.port2.unref(), c.port2.hasRef()));
  console.log(require('util').inspect(new MessageChannel(), { depth: 0 }));
  mc.port2.close();
}, 50);
