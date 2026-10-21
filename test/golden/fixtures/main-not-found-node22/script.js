// A main script that isn't there: Node's loader throws MODULE_NOT_FOUND
// (its header, its own frames and the props), exit 1, for `node x` and for
// fork('x') alike; a name without its extension, or a directory, is
// resolved as require() would (lib/foo -> lib/foo.js, pkg -> pkg/index.js,
// withmain -> its package.json's main, never its "exports": ex, ex2), a
// .json one parsed (data -> data.json), process.argv[1] the path as given.
const { spawn, fork } = require('child_process');
const shown = (s) => String(s).split(process.cwd()).join('<cwd>');

const run = (label, cp) =>
  new Promise((resolve) => {
    const out = { stdout: '', stderr: '' };
    cp.stdout.on('data', (d) => (out.stdout += d));
    cp.stderr.on('data', (d) => (out.stderr += d));
    cp.on('close', (code, signal) => {
      console.log(`--- ${label}: exit ${code} ${signal}`);
      if (out.stdout) process.stdout.write(shown(out.stdout));
      process.stdout.write(shown(out.stderr));
      resolve();
    });
  });

(async () => {
  for (const args of [['missing.js'], ['./lib/missing.mjs'], ['missing', 'a', 'b'], ['lib/foo'], ['pkg'], ['./pkg/'], ['withmain'], ['ex'], ['ex2'], ['data'], ['data.json']]) {
    await run(`node ${args.join(' ')}`, spawn(process.execPath, args));
  }
  await run("fork('./missing.js')", fork('./missing.js', [], { silent: true }));
})();
