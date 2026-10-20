// --watch's options as Node 22 parses them: empty values, invalid negations,
// the boolean forms (the last of --watch and --no-watch wins; --watch=<any>
// is watch mode), watch options in NODE_OPTIONS, and a preload, which runs
// in the watched child only, never in the watcher. A run in watch mode is
// stopped once the program has completed.
const { spawn } = require('child_process');
const path = require('path');
const show = (s) => s.split(process.execPath).join('<node>').trimEnd();
const run = (label, args, env = {}) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, args, { cwd: __dirname, env: { ...process.env, ...env } });
    let out = '';
    const take = (d) => {
      out += d;
      if (out.includes('Completed running')) c.kill();
    };
    c.stdout.on('data', take);
    c.stderr.on('data', take);
    c.on('close', (code, signal) => {
      console.log(`${label}: ${code ?? signal}\n  ${show(out).split('\n').join('\n  ')}`);
      resolve();
    });
  });
(async () => {
  await run('--watch-path=', ['--watch-path=', 'app.js']);
  await run('--watch-kill-signal=', ['--watch-kill-signal=', 'app.js']);
  await run('--no-watch-path=x', ['--no-watch-path=x', 'app.js']);
  await run('--no-watch-kill-signal=SIGINT', ['--no-watch-kill-signal=SIGINT', 'app.js']);
  await run('--no-watch', ['--no-watch', 'app.js']);
  await run('--watch --no-watch', ['--watch', '--no-watch', 'app.js']);
  await run('--watch-path=. --no-watch', ['--watch-path=.', '--no-watch', 'app.js']);
  await run('--no-watch-preserve-output', ['--no-watch-preserve-output', 'app.js']);
  await run('--watch-preserve-output=false', ['--watch-preserve-output=false', 'app.js']);
  await run('--no-watch --watch', ['--no-watch', '--watch', 'app.js']);
  await run('--watch=false', ['--watch=false', 'app.js']);
  await run('NODE_OPTIONS=--watch', ['app.js'], { NODE_OPTIONS: '--watch' });
  await run('NODE_OPTIONS=--watch-path=.', ['app.js'], { NODE_OPTIONS: '--watch-path=.' });
  await run('NODE_OPTIONS=--watch-preserve-output', ['app.js'], { NODE_OPTIONS: '--watch-preserve-output' });
  await run('NODE_OPTIONS=--watch-kill-signal=SIGINT', ['app.js'], { NODE_OPTIONS: '--watch-kill-signal=SIGINT' });
  await run('--watch -r ./pre.js', ['--watch', '-r', './pre.js', 'app.js']);
})();
