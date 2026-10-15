'use strict';
const a0 = process.argv[0], ep = process.execPath;
for (const k of ['argv0', 'pid', 'ppid', 'version', 'versions', 'arch', 'platform', 'release', 'config', 'features', 'execPath', 'title', 'exitCode', 'execArgv', 'env']) {
  const d = Object.getOwnPropertyDescriptor(process, k); const before = process[k];
  let r; try { process[k] = k === 'exitCode' ? 0 : 'zz'; r = process[k] === before ? 'assigned-unchanged' : 'assigned-changed'; } catch (e) { r = `${e.name}: ${e.message}`; }
  console.log(k, d ? `${'value' in d ? 'data' : 'accessor'} w=${d.writable} e=${d.enumerable} c=${d.configurable}` : 'inherited', r);
  if (k === 'title' || k === 'exitCode') continue;
}
process.exitCode = undefined;
console.log('argv[0] === execPath', a0 === ep, require('path').isAbsolute(ep), require('path').basename(ep));
console.log('versions frozen-ish', Object.isFrozen(process.versions), (() => { try { process.versions.node = 'x'; return process.versions.node === 'x'; } catch (e) { return e.name; } })());
let del; try { del = delete process.pid; } catch (e) { del = e.name; } console.log('delete pid', del, typeof process.pid);
