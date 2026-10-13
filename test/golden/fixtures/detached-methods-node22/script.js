// Node's process, os, Buffer, util, fs and path methods work called detached
// (`const { cwd } = process`; yargs' shim keeps `cwd: process.cwd`).
const t = (l, f) => { try { const v = f(); console.log(l, typeof v === 'object' && v !== null ? Object.keys(v).length >= 0 && (Array.isArray(v) ? 'array' : typeof v) : typeof v); } catch (e) { console.log(l, 'THROWS', e.name, e.message.split('\n')[0]); } };
const names = Object.keys(process).filter((k) => typeof process[k] === 'function').sort();
const skip = new Set(['exit', 'reallyExit', 'abort', 'kill', '_kill', 'chdir', 'binding', '_linkedBinding', 'dlopen', 'execve', 'setuid', 'setgid', 'seteuid', 'setegid', 'setgroups', 'initgroups', 'loadEnvFile', '_fatalException', '_debugProcess', '_debugEnd', '_startProfilerIdleNotifier', '_stopProfilerIdleNotifier', 'openStdin', 'setUncaughtExceptionCaptureCallback', 'setSourceMapsEnabled', '_rawDebug', 'ref', 'unref', 'assert', 'emitWarning', 'nextTick', 'getBuiltinModule', '_tickCallback']);
for (const n of ['cwd', 'umask', 'uptime', 'getuid', 'getgid', 'geteuid', 'getegid', 'getgroups', 'hrtime', 'memoryUsage', 'cpuUsage', 'resourceUsage', 'availableMemory', 'constrainedMemory', 'getActiveResourcesInfo', 'hasUncaughtExceptionCaptureCallback', '_getActiveHandles', '_getActiveRequests', 'threadCpuUsage']) {
  const f = process[n];
  t(n, () => f());
}
const { hrtime } = process; t('hrtime.bigint', () => hrtime.bigint());
const { memoryUsage } = process; t('memoryUsage.rss', () => memoryUsage.rss());
const { nextTick, emitWarning } = process; t('nextTick', () => nextTick(() => {}));
const { kill } = process; t('kill 0', () => kill(process.pid, 0));
const { getBuiltinModule } = process; t('getBuiltinModule', () => getBuiltinModule('fs'));
const { chdir } = process; t('chdir', () => chdir('.'));
const os = require('os'); for (const n of ['platform', 'cpus', 'homedir', 'tmpdir', 'hostname', 'userInfo', 'arch', 'release', 'type', 'endianness', 'freemem', 'totalmem', 'loadavg', 'networkInterfaces', 'uptime', 'machine', 'version', 'availableParallelism']) { const f = os[n]; t('os.' + n, () => f()); }
for (const n of ['from', 'alloc', 'allocUnsafe', 'allocUnsafeSlow', 'isBuffer', 'byteLength', 'concat', 'compare', 'isEncoding']) { const f = Buffer[n]; t('Buffer.' + n, () => n === 'concat' ? f([Buffer.from('a')]) : n === 'compare' ? f(Buffer.from('a'), Buffer.from('b')) : n === 'isBuffer' || n === 'isEncoding' ? f('utf8') : f(n === 'from' || n === 'byteLength' ? 'x' : 2)); }
const util = require('util'); for (const n of ['format', 'inspect', 'inherits', 'promisify', 'callbackify', 'deprecate', 'isDeepStrictEqual', 'stripVTControlCharacters', 'styleText', 'parseArgs', 'debuglog', 'getSystemErrorName', 'toUSVString', 'types.isDate']) { const f = n.includes('.') ? util.types.isDate : util[n]; t('util.' + n, () => n === 'inherits' ? f(function A() {}, function B() {}) : n === 'promisify' || n === 'callbackify' || n === 'deprecate' ? f(() => {}, 'x') : n === 'styleText' ? f('red', 'x', { validateStream: false }) : n === 'parseArgs' ? f({ args: [] }) : n === 'getSystemErrorName' ? f(-2) : f('x', 'y')); }
const fs = require('fs'); fs.rmSync('/tmp/detd', { recursive: true, force: true }); fs.writeFileSync('/tmp/det.txt', 'x'); for (const n of ['readFileSync', 'existsSync', 'statSync', 'readdirSync', 'writeFileSync', 'mkdirSync', 'realpathSync', 'openSync', 'closeSync']) { const f = fs[n]; t('fs.' + n, () => n === 'writeFileSync' ? f('/tmp/det.txt', 'x') : n === 'mkdirSync' ? f('/tmp/detd', { recursive: true }) : n === 'openSync' ? fs.closeSync(f('/tmp/det.txt')) : n === 'closeSync' ? f(fs.openSync('/tmp/det.txt')) : n === 'readdirSync' ? f('/tmp') : f('/tmp/det.txt')); }
const path = require('path'); for (const n of ['join', 'resolve', 'relative', 'dirname', 'basename', 'extname', 'normalize', 'isAbsolute', 'parse', 'format']) { const f = path[n]; t('path.' + n, () => n === 'format' ? f({ base: 'x' }) : n === 'relative' ? f('/a', '/b') : f('/a/b.c')); }
const { setTimeout: st, clearTimeout: ct, setImmediate: si, queueMicrotask: qm } = globalThis; t('timers', () => { ct(st(() => {}, 1)); si(() => {}); qm(() => {}); return 1; });
const { log, error } = console; t('console.log detached', () => log('detached log'));
console.log('own', ['cwd', 'umask', 'uptime', 'exit', 'kill', 'getuid', 'getBuiltinModule'].map((k) => Object.prototype.hasOwnProperty.call(process, k) && Object.keys(process).includes(k)).join(' '), process.cwd.name, typeof process.memoryUsage.rss);
console.log('missing in 22.22', ['resourceUsage', 'availableMemory', 'constrainedMemory', 'getActiveResourcesInfo', 'hasUncaughtExceptionCaptureCallback', 'setUncaughtExceptionCaptureCallback', 'threadCpuUsage', 'getBuiltinModule', 'ref', 'unref', 'abort', 'loadEnvFile'].filter((k) => typeof process[k] !== 'function'));
console.log('getBuiltinModule', process.getBuiltinModule('node:path') === require('path'), process.getBuiltinModule('nope'));
console.log('resourceUsage keys', Object.keys(process.resourceUsage()).join(' '));
