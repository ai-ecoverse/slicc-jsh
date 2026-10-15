const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-')));
const a = path.join(work, 'a');
const b = path.join(work, 'b');
fs.mkdirSync(a);
fs.mkdirSync(b);
const script = (dir, name, text, mode) => {
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho ${text} "$@"\n`);
  fs.chmodSync(path.join(dir, name), mode);
};
script(a, 'hello', 'hello-from-a', 0o755);
script(b, 'hello', 'hello-from-b', 0o755);
script(b, 'onlyb', 'onlyb', 0o755);
script(a, 'noexec', 'noexec-a', 0o644);
script(a, 'skipme', 'skipme-a', 0o644);
script(b, 'skipme', 'skipme-b', 0o755);
fs.mkdirSync(path.join(a, 'dirhit'));
script(b, 'dirhit', 'dirhit-b', 0o755);
script(work, 'here', 'here-cwd', 0o755);
const rel = (s) => String(s).split(work).join('<work>');
const env = (p) => ({ ...process.env, PATH: p });
const sync = (label, name, opts) => {
  const r = cp.spawnSync(name, ['x'], { encoding: 'utf8', ...opts });
  console.log(`${label}: ${r.error ? `error ${r.error.code} ${r.error.errno} ${r.error.syscall} ${rel(r.error.path)}` : `${r.status} ${r.stdout.trim()}`}`);
};
const async = (label, name, opts) =>
  new Promise((resolve) => {
    const c = cp.spawn(name, ['y'], opts);
    let out = '';
    c.stdout?.on('data', (d) => (out += d));
    c.on('error', (e) => {
      console.log(`${label}: error ${e.code} ${e.errno} ${e.syscall} ${rel(e.path)} ${rel(e.message)}`);
    });
    c.on('close', (code) => {
      if (code >= 0) console.log(`${label}: ${code} ${out.trim()}`);
      resolve();
    });
  });

(async () => {
  sync('a:b hello', 'hello', { env: env(`${a}:${b}`) });
  sync('b:a hello', 'hello', { env: env(`${b}:${a}`) });
  sync('a:b onlyb', 'onlyb', { env: env(`${a}:${b}`) });
  sync('a:b skipme (no x in a)', 'skipme', { env: env(`${a}:${b}`) });
  sync('a:b dirhit (a directory in a)', 'dirhit', { env: env(`${a}:${b}`) });
  sync('a:b noexec (no x anywhere)', 'noexec', { env: env(`${a}:${b}`) });
  sync('a:b missing', 'missing-zz', { env: env(`${a}:${b}`) });
  sync('empty entry is the cwd', 'here', { env: env(`${a}::${b}`), cwd: work });
  sync('a/hello relative to cwd', 'a/hello', { env: env(b), cwd: work });
  await async('spawn a:b hello', 'hello', { env: env(`${a}:${b}`) });
  await async('spawn b:a hello', 'hello', { env: env(`${b}:${a}`) });
  await async('spawn noexec', 'noexec', { env: env(`${a}:${b}`) });
  await async('spawn missing', 'missing-zz', { env: env(`${a}:${b}`) });
  console.log('execFileSync:', cp.execFileSync('onlyb', ['z'], { encoding: 'utf8', env: env(`${a}:${b}`) }).trim());
  try {
    cp.execFileSync('noexec', [], { env: env(`${a}:${b}`) });
  } catch (e) {
    console.log('execFileSync noexec:', e.code, e.syscall, rel(e.message));
  }
  await new Promise((resolve) =>
    cp.execFile('hello', ['w'], { env: env(`${b}:${a}`) }, (e, out) => {
      console.log('execFile:', e, out.trim());
      resolve();
    })
  );
  fs.rmSync(work, { recursive: true, force: true });
})();
