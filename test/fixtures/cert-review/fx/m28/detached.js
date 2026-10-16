const r = {};
for (const k of Object.keys(process).filter((k) => typeof process[k] === 'function').sort()) { const d = Object.getOwnPropertyDescriptor(process, k); r[k] = [d ? (d.enumerable ? 'own-enum' : 'own') : 'proto', process[k].name, process[k].length]; }
console.log(JSON.stringify(r));
const call = (k, ...a) => { try { const v = ({ f: process[k] }).f(...a); return v === undefined ? 'undef' : typeof v; } catch (e) { return 'throws ' + (e.code || e.name); } };
console.log(JSON.stringify(['cwd', 'uptime', 'umask', 'hrtime', 'memoryUsage', 'cpuUsage', 'resourceUsage', 'getuid', 'getgid', 'geteuid', 'getegid', 'getgroups', 'availableMemory', 'constrainedMemory', 'getActiveResourcesInfo'].map((k) => k + ':' + call(k))));
const { cwd, nextTick, hrtime } = process; let ticked = 0; nextTick(() => ticked++); setImmediate(() => console.log('detached nextTick ran', ticked, typeof hrtime.bigint(), cwd() === process.cwd()));
console.log('getBuiltinModule', typeof process.getBuiltinModule('fs').readFileSync, process.getBuiltinModule('node:path') === require('path'), process.getBuiltinModule('nope'));
console.log('memoryUsage.rss', typeof process.memoryUsage.rss());
