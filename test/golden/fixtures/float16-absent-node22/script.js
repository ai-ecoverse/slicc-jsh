const { Worker } = require('worker_threads');
const vm = require('vm');
const probe = () =>
  [
    `Float16Array ${typeof globalThis.Float16Array}`,
    `in globalThis ${'Float16Array' in globalThis}`,
    `own name ${Object.getOwnPropertyNames(globalThis).includes('Float16Array')}`,
    `Math.f16round ${typeof Math.f16round}`,
    `DataView getFloat16 ${typeof DataView.prototype.getFloat16}`,
    `DataView setFloat16 ${typeof DataView.prototype.setFloat16}`,
  ].join(' | ');
console.log('main |', probe());
console.log('vm |', vm.runInNewContext('[typeof Float16Array, typeof Math.f16round, typeof DataView.prototype.getFloat16].join(" | ")'));
let threw;
try {
  Float16Array;
} catch (e) {
  threw = `${e.name}: ${e.message}`;
}
console.log('reference |', threw);
console.log('util.types.isFloat16Array |', typeof require('util').types.isFloat16Array, require('util').types.isFloat16Array(new Uint16Array(1)));
const w = new Worker(`require('worker_threads').parentPort.postMessage((${probe})())`, { eval: true });
w.on('message', (m) => console.log('worker |', m));
