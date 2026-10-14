// Node's argument checks come before any call: the fd of every f* call (an
// int32 >= 0), then its other arguments (mode, len, uid/gid, times), the
// path's type for the path forms; a callback form throws them at the call.
// Also util.setTraceSigInt (any value) and util.getCallSite's warning type.
const fs = require('fs');
const util = require('util');
process.removeAllListeners('warning');
process.on('warning', (w) => console.log('warning', w.name, w.message));
const show = (label, fn) => {
  try {
    console.log(label, fn());
  } catch (e) {
    console.log(label, 'THROWS', e.code, e.message);
  }
};
for (const [name, args] of [
  ['fstatSync', ['/etc']],
  ['fsyncSync', ['/etc']],
  ['fdatasyncSync', ['/etc']],
  ['ftruncateSync', ['/etc']],
  ['fchmodSync', ['/etc', 0o644]],
  ['fchownSync', ['/etc', 0, 0]],
  ['futimesSync', ['/etc', 0, 0]],
  ['closeSync', ['/etc']],
  ['readSync', ['/etc', Buffer.alloc(1)]],
  ['writeSync', ['/etc', 'x']],
  ['fstatSync', [-1]],
  ['fstatSync', [1.5]],
  ['fstatSync', [2 ** 31]],
  ['fstatSync', [null]],
  ['fchmodSync', [99, 'x']],
  ['fchmodSync', [99, -1]],
  ['ftruncateSync', [99, 'x']],
  ['ftruncateSync', [99, 1.5]],
  ['futimesSync', [99, 'x', 0]],
  ['futimesSync', [99, 0, {}]],
  ['fchownSync', [99, -2, 0]],
  ['fchownSync', [99, 0, 'g']],
  ['chmodSync', [1, 'x']],
  ['chmodSync', ['/no/such/path', 'x']],
  ['chownSync', ['/no/such/path', 'a', 0]],
  ['utimesSync', ['/no/such/path', {}, 0]],
  ['lutimesSync', ['/no/such/path', 0, 'x']],
]) {
  show(`${name}(${args.map((a) => (typeof a === 'string' ? `'${a}'` : String(a))).join(', ')})`, () => fs[name](...args));
}
const cb = () => console.log('callback (must not run)');
show('fstat callback', () => fs.fstat('x', cb));
show('close callback', () => fs.close('x', cb));
show('read callback', () => fs.read('x', Buffer.alloc(1), 0, 1, 0, cb));
show('write callback', () => fs.write('x', 'y', cb));
show('futimes callback', () => fs.futimes(99, 'x', 0, cb));
show('fchmod callback', () => fs.fchmod(99, 'x', cb));
fs.fstat(99, (err) => console.log('fstat(99) callback', err.code));
show('util.setTraceSigInt(x)', () => util.setTraceSigInt('x'));
show('util.setTraceSigInt(false)', () => util.setTraceSigInt(false));
show('util.getCallSite', () => typeof util.getCallSite()[0].scriptName);
