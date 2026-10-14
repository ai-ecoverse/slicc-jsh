// process.finalization (Node's lib/internal/process/finalization.js): the
// callbacks of objects still alive at exit, beforeExit's first, once each.
// The warnings on stdout, without the pid.
process.removeAllListeners('warning');
process.on('warning', (w) => console.log('warning', w.name, w.message));
const kept = { name: 'kept' };
const dropped = { name: 'dropped' };
process.finalization.register(kept, (o, event) => console.log('exit callback', o.name, event));
process.finalization.registerBeforeExit(kept, (o, event) => console.log('beforeExit callback', o.name, event));
process.finalization.register(dropped, () => console.log('unregistered (must not run)'));
process.finalization.unregister(dropped);
for (const bad of [null, 1, 'x']) {
  try {
    process.finalization.register(bad, () => {});
  } catch (e) {
    console.log('register', String(bad), e.code);
  }
}
process.on('beforeExit', () => console.log('beforeExit listener'));
// The listener keeps `kept` alive to the end (a collected object's callback never runs).
process.on('exit', () => console.log('exit listener', kept.name));
console.log('main done');
