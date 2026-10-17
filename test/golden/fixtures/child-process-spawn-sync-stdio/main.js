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

process.stdout.write('before inherit\n');
show('inherit', () => {
  const r = node('console.log("from child stdout"); console.error("from child stderr")', { stdio: 'inherit' });
  return [r.status, r.output, r.stdout, r.stderr];
});
process.stdout.write('after inherit\n');
show('inherit array fds', () => node('console.log("child via fd 1")', { stdio: [0, 1, 2] }).output);
show('stdio objects', () => node('console.log("child via stream objects")', { stdio: [process.stdin, process.stdout, process.stderr] }).output);
show('stdout to fd 2', () => node('console.log("stdout went to stderr")', { stdio: ['pipe', 2, 'pipe'] }).output);
show('stdout to fd 2, past maxBuffer', () => {
  const r = node('process.stdout.write("z".repeat(64) + "\\n")', { stdio: ['pipe', 2, 'pipe'], maxBuffer: 8 });
  return [r.error && r.error.code, r.status, r.output];
});
show('cwd empty', () => {
  const r = node('', { cwd: '' });
  return [r.status, r.pid, r.error.message, r.error.code];
});
show('null stdio entries', () => node('console.log("n")', { stdio: [null, undefined, null], encoding: 'utf8' }).output);
show('exit code', () => node('process.exit(42)').status);
