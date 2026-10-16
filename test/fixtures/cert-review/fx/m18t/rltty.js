// ^C during a sync child on a terminal; events go to the log file argv[3]
const fs = require('fs'); const cp = require('child_process');
const mode = process.argv[2], LOG = process.argv[3];
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
log('start', mode);
if (mode === 'execsync-nohandler') {
  process.on('exit', (c) => log('exit', c));
  try { cp.execSync('sleep 10', { stdio: 'inherit' }); log('returned'); } catch (e) { log('threw', e.status, e.signal); }
  log('after (only if the program survived)');
} else if (mode === 'execsync-handler') {
  process.on('SIGINT', () => log('SIGINT handler ran'));
  try { cp.execSync('sleep 10', { stdio: 'inherit' }); log('returned'); } catch (e) { log('threw', e.status, e.signal); }
  log('after');
  setTimeout(() => log('later'), 300);
} else if (mode === 'spawnsync-handler-early') {
  process.on('SIGINT', () => log('SIGINT handler ran'));
  setTimeout(() => { const r = cp.spawnSync('sleep', ['10'], { stdio: 'inherit' }); log('spawnSync', r.status, r.signal); setTimeout(() => log('later'), 300); }, 500);
}
