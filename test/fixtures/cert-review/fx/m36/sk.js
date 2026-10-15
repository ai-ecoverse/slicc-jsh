const fs = require('fs');
const [how, sig = 'SIGTERM', tag = '/tmp/m36'] = process.argv.slice(2);
process.on('exit', (c) => { fs.writeFileSync(tag + '.exit', String(c)); console.log('exit listener'); });
process.stdout.write('before ' + how + ' ' + sig + '\n');
if (process.env.BIG) process.stdout.write('z'.repeat(Number(process.env.BIG)) + '\n');
Promise.resolve().then(() => fs.writeFileSync(tag + '.micro', 'x'));
setTimeout(() => fs.writeFileSync(tag + '.timer', 'x'), 0);
setImmediate(() => fs.writeFileSync(tag + '.immediate', 'x'));
process.nextTick(() => fs.writeFileSync(tag + '.tick', 'x'));
try {
  if (how === 'abort') process.abort();
  else process.kill(how === 'pid' ? process.pid : how === 'zero' ? 0 : -process.pid, /^\d+$/.test(sig) ? Number(sig) : sig);
  console.log('returned from kill');
} finally { fs.writeFileSync(tag + '.finally', 'x'); }
setTimeout(() => console.log('alive after timer'), 30);
