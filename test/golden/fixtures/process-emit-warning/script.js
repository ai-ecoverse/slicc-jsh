// stderr is captured in process (the pid varies) and printed to stdout.
const captured = [];
const write = process.stderr.write;
process.stderr.write = (chunk) => {
  captured.push(String(chunk).replace(/\(node:\d+\)/g, '(node:PID)'));
  return true;
};
const util = require('util');
const tty = require('tty');
process.on('warning', (w) => console.log('listener:', w.name, w.code, JSON.stringify(w.message), w.detail, w instanceof Error));
console.log('listeners', process.listenerCount('warning'), process.release.name);
process.emitWarning('plain');
process.emitWarning('typed', 'CustomWarning');
process.emitWarning('coded', 'CustomWarning', 'C1');
process.emitWarning('options', { type: 'OptWarning', code: 'C2', detail: 'more detail' });
process.emitWarning(Object.assign(new Error('an error'), { name: 'MyWarning' }));
for (const bad of [1, null, {}]) {
  try {
    process.emitWarning(bad);
  } catch (e) {
    console.log('throw', e.code, e.message);
  }
}
try {
  process.emitWarning('x', { type: 1 });
} catch (e) {
  console.log('throw', e.code, e.message);
}
const f = util.deprecate(function F(a, b) {
  return a + b;
}, 'f is deprecated', 'DEP_F');
const g = util.deprecate(() => 1, 'g shares the code', 'DEP_F');
const h = util.deprecate(() => 1, 'no code');
console.log('deprecated', f.name, f.length, f(1, 2), g(), h(), h());
try {
  util.deprecate(() => 1, 'm', 5);
} catch (e) {
  console.log('throw', e.code);
}
require('crypto').Hash('sha1');
const ws = Object.create(tty.WriteStream.prototype);
console.log('forced vs no-color', ws.getColorDepth({ FORCE_COLOR: '1', NO_COLOR: '1' }), ws.getColorDepth({ FORCE_COLOR: '3', NODE_DISABLE_COLORS: '1' }));
setTimeout(() => {
  process.stderr.write = write;
  console.log('--- stderr ---');
  console.log(captured.join(''));
}, 50);
