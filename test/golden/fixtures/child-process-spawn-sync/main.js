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

fs.rmSync('w-ss', { recursive: true, force: true });
fs.mkdirSync('w-ss/sub', { recursive: true });
fs.writeFileSync('w-ss/file', 'f');

show('keys', () => Object.keys(node('process.stdout.write("hi")')));
show('buffers', () => {
  const r = node('process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3');
  return [r.status, r.signal, r.output, r.stdout, r.stderr, typeof r.pid, r.pid > 0];
});
show('utf8', () => {
  const r = node('process.stdout.write("h\\u00e9"); process.stderr.write("e")', { encoding: 'utf8' });
  return [r.output, r.stdout, r.stderr];
});
show('latin1', () => node('process.stdout.write(Buffer.from([0xe9]))', { encoding: 'latin1' }).stdout);
show('hex', () => node('process.stdout.write("AB")', { encoding: 'hex' }).stdout);
show('input string', () => node('process.stdin.pipe(process.stdout)', { input: 'piped', encoding: 'utf8' }).stdout);
show('input buffer', () => node('process.stdin.pipe(process.stdout)', { input: Buffer.from('buf') }).stdout);
show('input uint8', () => node('process.stdin.pipe(process.stdout)', { input: new Uint8Array([65, 66]) }).stdout);
show('input hex enc', () => node('process.stdin.pipe(process.stdout)', { input: '4142', encoding: 'hex' }).stdout);
show('input via stdio', () => node('process.stdin.pipe(process.stdout)', { stdio: [{ input: 'x' }, 'pipe', 'pipe'] }));
show('no input = eof', () => node('let n=0; process.stdin.on("data",d=>n+=d.length).on("end",()=>console.log("end",n))', { encoding: 'utf8' }).stdout);
show('ignore', () => {
  const r = node('console.log("gone"); console.error("gone")', { stdio: 'ignore' });
  return [Object.keys(r), r.status, r.output, r.stdout, r.stderr];
});
show('ignore stdout only', () => {
  const r = node('console.log("gone"); console.error("kept")', { stdio: ['pipe', 'ignore', 'pipe'], encoding: 'utf8' });
  return [r.output, r.stdout, r.stderr];
});
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
show('cwd relative', () => node('console.log(process.cwd())', { cwd: 'w-ss/sub', encoding: 'utf8' }).stdout);
show('cwd URL', () => node('console.log(process.cwd())', { cwd: new URL(`file://${process.cwd()}/w-ss`), encoding: 'utf8' }).stdout);
show('cwd missing', () => {
  const r = node('', { cwd: 'w-ss/nope' });
  return [Object.keys(r), r.status, r.signal, r.output, r.pid, r.stdout, r.error.message, r.error.code, r.error.errno, r.error.syscall, r.error.path, r.error.spawnargs];
});
show('cwd file', () => {
  const r = node('', { cwd: 'w-ss/file' });
  return [r.status, r.pid, r.error.message, r.error.code, r.error.errno];
});
show('env', () => node('console.log(JSON.stringify([process.env.A, process.env.B, "U" in process.env]))', {
  env: { PATH: process.env.PATH, A: 'a', B: 2, U: undefined },
  encoding: 'utf8',
}).stdout);
show('env inherited', () => {
  process.env.SS_INHERIT = 'yes';
  return node('console.log(process.env.SS_INHERIT)', { encoding: 'utf8' }).stdout;
});
show('args stringified', () => cp.spawnSync('node', ['-e', 'console.log(process.argv.slice(1).join(","))', 1, true, null], { encoding: 'utf8' }).stdout);
show('shell option', () => cp.spawnSync('node', ['-e', '"console.log(1+1)"'], { shell: false, encoding: 'utf8' }).stdout);
show('ENOENT', () => {
  const r = cp.spawnSync('no-such-cmd-ss', ['a', 'b']);
  const e = r.error;
  return [Object.keys(r), Object.keys(e), e instanceof Error, e.message, e.errno, e.code, e.syscall, e.path, e.spawnargs, r.status, r.signal, r.output, r.pid, r.stdout, r.stderr];
});
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
show('file not string', () => cp.spawnSync(5));
show('file empty', () => cp.spawnSync(''));
show('file null byte', () => cp.spawnSync('no\0de'));
show('args not object', () => cp.spawnSync('node', 5));
show('options not object', () => cp.spawnSync('node', [], 'str'));
show('args as options', () => cp.spawnSync('node', { encoding: 'utf8', input: 'console.log("stdin script")' }).stdout);
show('arg null byte', () => cp.spawnSync('node', ['a\0b']));
show('cwd number', () => cp.spawnSync('node', { cwd: 5 }));
show('shell number', () => cp.spawnSync('node', { shell: 5 }));
show('timeout negative', () => cp.spawnSync('node', { timeout: -1 }));
show('timeout string', () => cp.spawnSync('node', { timeout: '5' }));
show('timeout Infinity', () => cp.spawnSync('node', { timeout: Infinity }));
show('maxBuffer negative', () => cp.spawnSync('node', { maxBuffer: -1 }));
show('killSignal unknown', () => cp.spawnSync('node', { killSignal: 'SIGNOPE' }));
show('killSignal 99', () => cp.spawnSync('node', { killSignal: 99 }));
show('killSignal object', () => cp.spawnSync('node', { killSignal: {} }));
show('stdio bogus', () => cp.spawnSync('node', { stdio: 'bogus' }));
show('stdio number', () => cp.spawnSync('node', { stdio: 5 }));
show('stdio object no fd', () => cp.spawnSync('node', { stdio: ['pipe', {}, 'pipe'] }));
show('stdio ipc', () => cp.spawnSync('node', { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }));
show('input number', () => cp.spawnSync('node', { input: 5 }));
show('input with encoding buffer', () => cp.spawnSync('node', { input: 'x', encoding: 'buffer' }));
show('env null byte', () => cp.spawnSync('node', { env: { 'A\0': 'x' } }));
show('windowsHide not bool', () => cp.spawnSync('node', { windowsHide: 1 }));
show('windowsHide ignored', () => node('console.log("wh")', { windowsHide: true, encoding: 'utf8' }).stdout);
show('detached not bool', () => cp.spawnSync('node', { detached: 'yes' }));
show('uid not int', () => cp.spawnSync('node', { uid: 1.5 }));
show('encoding unknown, no output', () => node('', { encoding: 'bogus' }).output);
show('encoding unknown', () => node('console.log(1)', { encoding: 'bogus' }));
fs.rmSync('w-ss', { recursive: true, force: true });
