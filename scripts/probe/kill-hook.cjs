// PROBE (#250): log every host kill a JS caller makes, with its stack.
const fs = require('fs');
const log = process.env.KILL_LOG || '/tmp/kill-hook.log';
const { threadId } = require('worker_threads');
const note = (what, pid, sig) => {
  try { fs.appendFileSync(log, `${new Date().toISOString()} pid=${process.pid} tid=${threadId} ${what}(${pid}, ${sig})\n${new Error('at').stack.split('\n').slice(2, 12).join('\n')}\n\n`); } catch {}
};
const realKill = process.kill;
process.kill = function (pid, sig) { note('process.kill', pid, sig); return realKill.apply(this, arguments); };
const realRaw = process._kill;
if (typeof realRaw === 'function') process._kill = function (pid, sig) { note('process._kill', pid, sig); return realRaw.apply(this, arguments); };
try {
  const cp = require('child_process');
  const real = cp.ChildProcess.prototype.kill;
  cp.ChildProcess.prototype.kill = function (sig) { note('ChildProcess.kill', this.pid, sig); return real.apply(this, arguments); };
} catch {}
