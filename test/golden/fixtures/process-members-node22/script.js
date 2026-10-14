// The process members jsh adds for Node's shape, as Node 22.22.0 answers them
// (what doesn't depend on the platform: a native addon's dlopen message,
// the errno tables and the option table's order do).
const util = require('util');
const show = (label, fn) => {
  try {
    console.log(label, util.inspect(fn(), { depth: 1, breakLength: 160 }));
  } catch (e) {
    console.log(label, 'THROWS', e.name, e.code, JSON.stringify(e.message), e.errno, e.syscall);
  }
};
show('_debugEnd', () => process._debugEnd());
show('_debugProcess no such pid', () => process._debugProcess(999999));
show('_startProfilerIdleNotifier', () => process._startProfilerIdleNotifier());
show('_kill self 0', () => process._kill(process.pid, 0));
show('_kill no such pid', () => process._kill(999999, 15));
show('_linkedBinding', () => process._linkedBinding('x'));
show('_preload_modules', () => process._preload_modules);
show('_tickCallback', () => {
  const r = [];
  process.nextTick(() => r.push('tick'));
  process._tickCallback();
  r.push('after');
  return r;
});
show('_fatalException without listener', () => process._fatalException(new Error('x'), false));
show('_fatalException with listener', () => {
  const seen = [];
  const l = (e, origin) => seen.push(e.message, origin);
  process.on('uncaughtException', l);
  const r = process._fatalException(new Error('y'), false);
  process.off('uncaughtException', l);
  return [r, seen];
});
const flags = process.allowedNodeEnvironmentFlags;
show('flags', () => [flags.size, flags instanceof Set, flags.constructor.name, Object.prototype.toString.call(flags), Object.isFrozen(flags)]);
show('flags has', () => ['--max_old_space_size', '--max-old-space-size=4', 'max-old-space-size', '-r', '--require', '--eval', '--no-warnings', 'no_warnings', 1].map((f) => flags.has(f)));
show('flags no-ops', () => [flags.add('--zz') === flags, flags.has('--zz'), flags.delete('--require'), flags.has('--require'), flags.clear(), flags.size]);
show('flags iterate', () => [[...flags].length, [...flags.keys()].length === [...flags.values()].length, [...flags].includes('--require'), [...flags.entries()][0].length]);
show('flags forEach count', () => {
  let n = 0;
  flags.forEach(() => n++);
  return n;
});
show('flags set', () => {
  process.allowedNodeEnvironmentFlags = 5;
  const v = process.allowedNodeEnvironmentFlags;
  process.allowedNodeEnvironmentFlags = flags;
  return v;
});
show('assert ok', () => process.assert(1));
show('assert fails', () => process.assert(0, 'msg'));
show('assert default message', () => process.assert(false));
show('binding nope', () => process.binding('nope'));
show('binding constants', () => Object.keys(process.binding('constants')));
show('binding constants os.signals.SIGTERM', () => process.binding('constants').os.signals.SIGTERM);
show('binding constants trace', () => process.binding('constants').trace);
show('binding constants internal', () => process.binding('constants').internal);
show('binding util', () => Object.keys(process.binding('util')));
show('binding util isDate', () => process.binding('util').isDate(new Date()));
show('binding uv errname', () => process.binding('uv').errname(-2));
show('binding uv UV_ENOENT', () => process.binding('uv').UV_ENOENT);
show('binding config keys', () => Object.keys(process.binding('config')));
show('debugPort', () => process.debugPort);
show('dlopen()', () => process.dlopen());
show('dlopen({})', () => process.dlopen({}, '/x.node'));
show('dlopen(null)', () => process.dlopen(null, '/x.node'));
show('dlopen missing', () => {
  try {
    process.dlopen({ exports: {} }, '/nope.node');
  } catch (e) {
    return [e.name, e.code, e.message.includes('/nope.node')];
  }
});
show('execve bad path', () => process.execve(1));
show('execve bad args', () => process.execve('/bin/sh', 'x'));
show('execve null byte', () => process.execve('/bin/sh', ['a\u0000']));
show('execve bad env', () => process.execve('/bin/sh', [], { A: 1 }));
show('finalization keys', () => Object.keys(process.finalization));
show('mainModule', () => [process.mainModule === require.main, process.mainModule.id]);
show('moduleLoadList', () => Array.isArray(process.moduleLoadList));
show('openStdin', () => {
  const s = process.openStdin();
  s.pause();
  return s === process.stdin;
});
show('report same', () => process.report === process.report);
show('report settings', () => Object.fromEntries(['directory', 'filename', 'compact', 'excludeNetwork', 'signal', 'reportOnFatalError', 'reportOnSignal', 'reportOnUncaughtException', 'excludeEnv'].map((k) => [k, process.report[k]])));
show('report keys', () => Object.keys(process.report));
const r = process.report.getReport();
show('getReport keys', () => Object.keys(r));
// Linux builds add glibcVersionRuntime / glibcVersionCompiler (macOS's don't).
show('getReport header keys', () => Object.keys(r.header).filter((k) => !k.startsWith('glibc')));
show('getReport header', () => [r.header.reportVersion, r.header.event, r.header.trigger, r.header.filename, r.header.processId === process.pid, r.header.threadId, r.header.nodejsVersion, r.header.wordSize, r.header.cwd === process.cwd()]);
show('getReport synthetic message', () => r.javascriptStack.message);
show('getReport error', () => {
  const e = new Error('boom');
  e.extra = 1;
  const js = process.report.getReport(e).javascriptStack;
  return [js.message, js.errorProperties, Array.isArray(js.stack)];
});
show('getReport bad', () => process.report.getReport(1));
show('writeReport bad', () => process.report.writeReport(1));
show('report.signal bad', () => (process.report.signal = 'X'));
show('report.compact bad', () => (process.report.compact = 1));
show('report.directory bad', () => (process.report.directory = 1));
show('sourceMapsEnabled', () => process.sourceMapsEnabled);
show('setSourceMapsEnabled bad', () => process.setSourceMapsEnabled('x'));
show('setSourceMapsEnabled', () => [process.setSourceMapsEnabled(true), process.sourceMapsEnabled]);
process.on('exit', () => console.log('exit event (must not run)'));
console.log('reallyExit(3)');
process.reallyExit(3);
console.log('after reallyExit (must not run)');
