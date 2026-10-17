const cp = require('child_process');
const fs = require('fs');

const mask = (s) => String(s).split(process.cwd()).join('CWD');
const node = (src, opts) => cp.spawnSync('node', ['-e', src], opts);
const show = (label, fn) => {
  let s;
  try {
    s = JSON.stringify(fn(), (k, v) => (Buffer.isBuffer(v) ? `<Buffer ${v.toString('hex')}>` : v));
  } catch (e) {
    s = `THROW ${e.name} ${e.code}: ${e.message}`;
  }
  console.log(`${label}: ${mask(s)}`);
};

show('ETIMEDOUT', () => {
  const r = node('setTimeout(() => {}, 20000)', { timeout: 300 });
  return [Object.keys(r), r.error.code, r.error.message, r.error.syscall, r.status, r.signal];
});
show('ETIMEDOUT killSignal', () => {
  const r = node('setTimeout(() => {}, 20000)', { timeout: 300, killSignal: 'SIGKILL' });
  return [r.error.code, r.status, r.signal];
});
show('ETIMEDOUT killSignal number', () => {
  const r = node('setTimeout(() => {}, 20000)', { timeout: 300, killSignal: 9 });
  return [r.error.code, r.status, r.signal];
});
show('timeout 0 is none', () => node('setTimeout(() => console.log("late"), 200)', { timeout: 0, encoding: 'utf8' }).stdout);
show('ENOBUFS', () => {
  const r = node('process.stdout.write("x".repeat(100)); setTimeout(() => {}, 20000)', { maxBuffer: 10 });
  return [r.error.code, r.error.message, r.status, r.signal, r.stdout.length >= 10];
});
show('maxBuffer Infinity', () => node('process.stdout.write("x".repeat(2000000))', { maxBuffer: Infinity }).stdout.length);
show('maxBuffer default 1MiB', () => {
  const r = node('process.stdout.write("x".repeat(1100000)); setTimeout(() => {}, 20000)');
  return [r.error && r.error.code, r.signal];
});
