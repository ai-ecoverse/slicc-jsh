const cp = require('child_process');
const fs = require('fs');

const mask = (s) => String(s).split(process.cwd()).join('CWD');
const enc = (v) => (Buffer.isBuffer(v) ? `<Buffer ${JSON.stringify(v.toString())}>` : v);
const show = (label, fn) => {
  let s;
  try {
    s = JSON.stringify(fn(), (k, v) => (v && v.type === 'Buffer' && Array.isArray(v.data) ? `<Buffer ${JSON.stringify(Buffer.from(v.data).toString())}>` : v));
  } catch (e) {
    s = `THROW ${e.name} ${e.code}: ${e.message}`;
  }
  console.log(`${label}: ${mask(s)}`);
};
const caught = (fn) => {
  try {
    return ['no throw', enc(fn())];
  } catch (e) {
    return {
      message: e.message,
      name: e.name,
      code: e.code,
      keys: Object.keys(e),
      status: e.status,
      signal: e.signal,
      output: e.output,
      stdout: e.stdout,
      stderr: e.stderr,
      pid: typeof e.pid,
      self: e.error === e,
    };
  }
};

fs.rmSync('w-es', { recursive: true, force: true });
fs.mkdirSync('w-es/sub', { recursive: true });

show('execSync buffer', () => enc(cp.execSync('printf hi')));
show('execSync utf8', () => cp.execSync('printf "%s\\n" one two', { encoding: 'utf8' }));
show('execSync input', () => cp.execSync('read -r l; printf "[%s]" "$l"', { input: 'line in\n', encoding: 'utf8' }));
show('execSync env', () => cp.execSync('printf "%s" "$ES_X"', { env: { ...process.env, ES_X: 'xv' }, encoding: 'utf8' }));
show('execSync cwd', () => cp.execSync('pwd', { cwd: 'w-es/sub', encoding: 'utf8' }));
show('execSync shell string', () => cp.execSync('printf "%s" ok', { shell: '/bin/sh', encoding: 'utf8' }));
show('execSync failing', () => caught(() => cp.execSync('printf out; printf err >&2; exit 3', { stdio: 'pipe' })));
show('execSync failing utf8', () => caught(() => cp.execSync('exit 5', { encoding: 'utf8' })));
process.stderr.write('[before passthrough]\n');
show('execSync stderr passthrough', () => cp.execSync('printf "to stderr\\n" >&2; printf ok', { encoding: 'utf8' }));
process.stderr.write('[after passthrough]\n');
show('execSync stderr pipe kept', () => cp.execSync('printf "kept\\n" >&2', { stdio: 'pipe', encoding: 'utf8' }));
show('execSync failing stderr passthrough', () => caught(() => cp.execSync('printf "boom\\n" >&2; exit 2', { encoding: 'utf8' })));
console.log('[before inherit]');
show('execSync inherit', () => cp.execSync('printf "child line\\n"', { stdio: 'inherit' }));
console.log('[after inherit]');
show('execSync timeout', () => {
  const e = caught(() => cp.execSync('while :; do :; done', { timeout: 300 }));
  return [e.message, e.code, e.signal, e.status, e.self, e.keys];
});
show('execSync maxBuffer', () => {
  const e = caught(() => cp.execSync('printf 0123456789abcdef; while :; do :; done', { maxBuffer: 4 }));
  return [e.message, e.code, e.signal, e.self];
});
show('execSync bad shell', () => {
  const e = caught(() => cp.execSync('true', { shell: '/no/such/sh' }));
  return [e.message, e.code, e.status, e.pid, e.self];
});
show('execSync not string', () => cp.execSync(5));
show('execSync null byte', () => cp.execSync('echo \0'));
show('execSync options string', () => enc(cp.execSync('printf s', 'str')));

show('execFileSync buffer', () => enc(cp.execFileSync('node', ['-e', 'process.stdout.write("hi")'])));
show('execFileSync utf8', () => cp.execFileSync('node', ['-e', 'console.log(process.argv.slice(1))', 'a', 'b c'], { encoding: 'utf8' }));
show('execFileSync options as args', () => cp.execFileSync('node', { input: 'console.log("from stdin")', encoding: 'utf8' }));
show('execFileSync failing', () => caught(() => cp.execFileSync('node', ['-e', 'process.stdout.write("o"); process.stderr.write("e\\n"); process.exit(4)'], { stdio: 'pipe', encoding: 'utf8' })));
show('execFileSync argv0 message', () => caught(() => cp.execFileSync('sh', ['-c', 'exit 2'], { argv0: 'zork', stdio: 'pipe' })).message);
show('execFileSync shell', () => cp.execFileSync('printf', ['"%s|"', 'a', 'b'], { shell: true, encoding: 'utf8' }));
show('execFileSync shell failing', () => caught(() => cp.execFileSync('exit', ['7'], { shell: true, stdio: 'pipe' })).message);
show('execFileSync ENOENT', () => {
  const e = caught(() => cp.execFileSync('no-such-cmd-es', ['x']));
  return [e.message, e.code, e.keys, e.status, e.output, e.pid, e.self];
});
show('execFileSync options string', () => cp.execFileSync('node', [], 'str'));
show('execFileSync args number', () => cp.execFileSync('node', 5));
show('execFileSync killed', () => {
  const e = caught(() => cp.execFileSync('sh', ['-c', 'kill -TERM $$'], { stdio: 'pipe', timeout: 5000 }));
  return [e.message, e.code];
});

// A signal the program catches waits until the sync call returns. (The
// handler is installed a tick before: the kernel's ctx.signals.on is async.)
process.on('SIGUSR1', () => console.log('SIGUSR1 handler ran'));
setTimeout(() => {
  show('signal during execSync', () => cp.execSync('kill -USR1 $PPID; printf done', { encoding: 'utf8' }));
  console.log('after signal call');
  setTimeout(() => {
    fs.rmSync('w-es', { recursive: true, force: true });
    console.log('end');
  }, 100);
}, 50);
