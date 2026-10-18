// node --watch against host Node 22. Each step waits for the watch process's
// output; a change is made only once the child has said what it loaded.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')));
const at = (f) => path.join(dir, f);
const clean = (s) => s.split(dir).join('DIR');
fs.writeFileSync(at('dep.js'), 'module.exports = 1;\n');
fs.writeFileSync(at('esm-dep.mjs'), 'export default "a";\n');
fs.writeFileSync(at('unrelated.js'), '// never loaded\n');
fs.writeFileSync(
  at('app.js'),
  `const dep = require('./dep.js');
let later;
try { later = require('./later.js'); } catch { later = 'missing'; }
import('./esm-dep.mjs').then((m) => console.log('app: dep', dep, 'later', later, 'esm', m.default, 'execArgv', JSON.stringify(process.execArgv), 'watch env', process.env.WATCH_REPORT_DEPENDENCIES));
`
);
fs.mkdirSync(at('sub'));
fs.writeFileSync(at('sub/data.txt'), 'x');
fs.writeFileSync(at('plain.js'), 'console.log("plain: ran", process.argv.slice(2).join(" "), typeof process.send);\n');

function watchRun(args) {
  const child = spawn(process.execPath, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const waiters = [];
  const check = () => {
    for (const w of [...waiters]) {
      if (out.split(w.text).length - 1 >= w.count) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };
  child.stdout.on('data', (d) => {
    out += d;
    check();
  });
  child.stderr.on('data', (d) => {
    out += d;
    check();
  });
  return {
    child,
    // Resolves once `text` has been printed `count` times.
    waitFor: (text, count = 1) =>
      new Promise((resolve) => {
        waiters.push({ text, count, resolve });
        check();
      }),
    output: () => clean(out),
    closed: new Promise((resolve) => child.on('close', (code, signal) => resolve([code, signal]))),
  };
}

(async () => {
  console.log('--- --watch app.js');
  const w = watchRun(['--watch', 'app.js']);
  await w.waitFor('Completed running', 1);
  // A file it requires changes: one restart.
  fs.writeFileSync(at('dep.js'), 'module.exports = 2;\n');
  await w.waitFor('Completed running', 2);
  // A module it imports changes.
  fs.writeFileSync(at('esm-dep.mjs'), 'export default "b";\n');
  await w.waitFor('Completed running', 3);
  // (A relative require that wasn't found is reported too, but whether its
  // appearing restarts is the platform's: Linux's watcher can't watch a file
  // that isn't there, macOS's watches the directory.)
  // A file it never loaded, then one it did: one restart, for the second.
  fs.writeFileSync(at('unrelated.js'), '// changed\n');
  fs.writeFileSync(at('dep.js'), 'module.exports = 3;\n');
  await w.waitFor('Completed running', 4);
  w.child.kill('SIGTERM');
  console.log(w.output());
  console.log('watch exit', JSON.stringify(await w.closed));

  console.log('--- --watch-path=sub plain.js a b');
  const p = watchRun(['--watch-path=sub', '--watch-preserve-output', 'plain.js', 'a', 'b']);
  await p.waitFor('Completed running', 1);
  fs.writeFileSync(at('sub/data.txt'), 'y');
  await p.waitFor('Completed running', 2);
  p.child.kill('SIGTERM');
  console.log(p.output());
  console.log('watch exit', JSON.stringify(await p.closed));

  console.log('--- a failing program');
  fs.writeFileSync(at('fail.js'), 'process.exitCode = 3;\n');
  const f = watchRun(['--watch', 'fail.js']);
  await f.waitFor('Failed running', 1);
  f.child.kill('SIGTERM');
  console.log(f.output());
  console.log('watch exit', JSON.stringify(await f.closed));

  console.log('--- flag errors');
  for (const args of [['--watch'], ['--watch', '-e', '1'], ['--watch', '-p', '1'], ['--watch', '--check', 'app.js'], ['--watch', '-i'], ['--watch-path'], ['--watch-kill-signal']]) {
    const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', stdin: 'ignore' });
    console.log(JSON.stringify(args), r.status, JSON.stringify(r.stderr.split(process.execPath).join('NODE')));
  }
  fs.rmSync(dir, { recursive: true, force: true });
})();
