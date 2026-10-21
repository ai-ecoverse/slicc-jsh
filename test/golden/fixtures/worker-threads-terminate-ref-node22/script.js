const { Worker } = require('worker_threads');
const early = new Worker('setInterval(() => {}, 1000)', { eval: true });
let earlyCode;
early.on('exit', (code) => {
  earlyCode = code;
  console.log('exit before it was up');
});
early.unref();
early.terminate().then((code) => {
  console.log('terminated with its exit code', code === earlyCode);
  const up = new Worker('require("worker_threads").parentPort.postMessage("up"); setInterval(() => {}, 1000)', { eval: true });
  up.on('exit', (code) => console.log('exit', code));
  up.once('message', (m) => {
    console.log(m);
    up.unref();
    up.terminate().then((code) => console.log('terminated', code));
  });
});
process.on('exit', (code) => console.log('the program ends', code));
