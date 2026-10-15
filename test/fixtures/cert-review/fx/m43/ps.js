const cp = require('child_process');
const info = (pid) => { const o = cp.execFileSync('ps', ['-o', 'pid=,ppid=,pgid=,stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/); return { pid: +o[0], ppid: +o[1], pgid: +o[2], stat: o[3] || '' }; };
module.exports = { info, alive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } };
