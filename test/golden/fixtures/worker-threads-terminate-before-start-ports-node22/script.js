const { Worker, MessageChannel } = require('worker_threads');
const w = new Worker("require('worker_threads').parentPort.on('message', () => {})", { eval: true });
const closed = [];
const sent = new MessageChannel();
sent.port2.on('message', () => console.log('message'));
sent.port2.on('close', () => closed.push('the port it was sent'));
const queued = new MessageChannel();
queued.port2.on('message', () => console.log('message'));
queued.port2.on('close', () => closed.push('the port queued on it'));
sent.port2.postMessage({ queued: queued.port1 }, [queued.port1]);
w.postMessage({ port: sent.port1 }, [sent.port1]);
w.on('exit', (code) => console.log('exit', code));
w.terminate().then((code) => console.log('terminated', code));
setTimeout(() => {
  console.log('still open');
  process.exit(0);
}, 3000).unref();
process.on('exit', (code) => console.log('closed:', closed.sort().join(', '), '; the program ends', code));
