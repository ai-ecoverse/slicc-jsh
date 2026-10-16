const r = {};
for (const k of ['cwd', 'uptime', 'hrtime', 'memoryUsage', 'cpuUsage', 'umask', 'getuid', 'getgid', 'geteuid', 'getgroups', 'emitWarning', 'nextTick', 'exit', 'kill', 'chdir', 'resourceUsage']) {
  const f = process[k]; if (typeof f !== 'function') { r[k] = 'n/a'; continue; }
  if (['exit', 'kill', 'chdir', 'emitWarning'].includes(k)) { r[k] = typeof f; continue; }
  try { const v = f(); r[k] = v === undefined ? 'undefined' : typeof v; } catch (e) { r[k] = 'throws ' + (e.code || e.name); }
  try { const v = ({ m: f }).m(); r[k] += '/' + (v === undefined ? 'undefined' : typeof v); } catch (e) { r[k] += '/throws ' + (e.code || e.name); }
}
console.log(JSON.stringify(r));
const os = require('os'); const path = require('path');
const o = {}; for (const k of ['homedir', 'tmpdir', 'hostname', 'platform', 'cpus', 'userInfo', 'loadavg', 'totalmem']) { try { o[k] = typeof os[k].call(undefined); } catch (e) { o[k] = 'throws ' + e.code; } }
console.log(JSON.stringify(o));
const pj = path.join; const pr = path.relative; console.log(pj('a', 'b'), pr('/a', '/a/b'), ({ r: path.resolve }).r('x').length > 0);
