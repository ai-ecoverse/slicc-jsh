const wt = require('worker_threads');
console.log('worker_threads', wt.isMainThread, wt.threadId, wt.parentPort, typeof wt.Worker, typeof wt.MessageChannel, typeof wt.BroadcastChannel === typeof BroadcastChannel);
console.log('workerData', wt.workerData, 'resourceLimits', JSON.stringify(wt.resourceLimits));
const a = new BroadcastChannel('ch'), b = new BroadcastChannel('ch'), c = new BroadcastChannel('other');
const got = [];
b.onmessage = (e) => got.push(`b:${JSON.stringify(e.data)}`);
c.onmessage = (e) => got.push(`c:${e.data}`);
a.onmessage = (e) => got.push(`a-self:${e.data}`);
a.postMessage({ n: 1, s: 'x' }); a.postMessage('two');
const { port1, port2 } = new MessageChannel(); port2.onmessage = (e) => { got.push(`port:${e.data}`); port2.close(); }; port1.postMessage('mc');
setTimeout(() => { console.log('got', got.join(' ')); a.close(); b.close(); c.close(); try { a.postMessage('after'); console.log('post after close ok'); } catch (e) { console.log('post after close', e.name); } console.log('name', a.name); }, 100);
try { new wt.Worker('console.log(1)', { eval: true }); console.log('Worker constructed'); } catch (e) { console.log('Worker', e.code || e.name); }
