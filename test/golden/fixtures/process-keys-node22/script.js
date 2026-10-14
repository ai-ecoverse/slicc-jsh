// process's own enumerable shape, against host Node: Object.keys, for … in,
// and the descriptors of what Node has as own accessors / values. NOT_YET is
// what jsh doesn't have yet (each later change takes its names out).
const NOT_YET = new Set([
  // Until the kernel gives JS programs ctx.sync.cred / setcred.
  'initgroups', 'setegid', 'seteuid', 'setgid', 'setgroups', 'setuid',
]);
const keys = Object.keys(process).filter((k) => !NOT_YET.has(k)).sort();
console.log('keys:', keys.join(' '));
const forIn = [];
for (const k in process) if (!NOT_YET.has(k)) forIn.push(k);
// for … in adds the inherited enumerables (EventEmitter's prototype methods).
console.log('for-in beyond keys:', forIn.filter((k) => !keys.includes(k)).sort().join(' '));
console.log('internal (_) keys:', keys.filter((k) => k.startsWith('_')).join(' '));
const shape = (name) => {
  const d = Object.getOwnPropertyDescriptor(process, name);
  if (!d) return 'none';
  const fn = typeof d.value === 'function' ? ` ${JSON.stringify(d.value.name)}/${d.value.length}` : '';
  return `${'value' in d ? `value writable=${d.writable}` : `accessor set=${typeof d.set}`} enumerable=${d.enumerable} configurable=${d.configurable}${fn}`;
};
for (const name of ['stdin', 'stdout', 'stderr', 'exitCode', 'title', '_exiting', '_getActiveHandles', '_getActiveRequests', '_rawDebug', 'cwd', 'nextTick',
  '_debugEnd', '_debugProcess', '_fatalException', '_kill', '_linkedBinding', '_preload_modules',
  '_startProfilerIdleNotifier', '_stopProfilerIdleNotifier', '_tickCallback', 'allowedNodeEnvironmentFlags', 'assert',
  'binding', 'debugPort', 'dlopen', 'execve', 'finalization', 'mainModule', 'moduleLoadList', 'openStdin', 'reallyExit',
  'report', 'setSourceMapsEnabled', 'sourceMapsEnabled']) {
  console.log(name, shape(name));
}
// A later assignment of a jsh internal stays out of the keys.
process.title = 'renamed';
process.exitCode = 0;
console.log('title', process.title, Object.keys(process).includes('title'));
console.log('exitCode', process.exitCode, Object.keys(process).includes('exitCode'));
const json = JSON.parse(JSON.stringify(Object.fromEntries(Object.keys(process).filter((k) => k.startsWith('_') && !NOT_YET.has(k)).sort().map((k) => [k, typeof process[k]]))));
console.log('typeof internals:', JSON.stringify(json));
