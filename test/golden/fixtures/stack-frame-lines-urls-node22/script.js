// A module's frames carry its URL's query and fragment (file:///x.mjs?v=1),
// and a CommonJS file's frames count its hashbang line, as Node's do. The
// uncaught reports run as children, their paths shown relative to here.
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const clean = (text) =>
  text
    .split(pathToFileURL(__dirname).href)
    .join('file://DIR')
    .split(__dirname)
    .join('DIR')
    .split('\n')
    // Node's own frames go; the `{` of an error's props block that ends the
    // last of them goes on the last frame left.
    .reduce((out, l) => {
      if (!/\(node:|at node:/.test(l)) out.push(l);
      else if (l.endsWith(' {') && out.length && !out[out.length - 1].endsWith('{')) out[out.length - 1] += ' {';
      return out;
    }, [])
    .join('\n');
const child = (file) => {
  const r = spawnSync(process.execPath, [file], { cwd: __dirname, encoding: 'utf8' });
  console.log(`== ${file}: status ${r.status}`);
  process.stdout.write(clean(r.stdout + r.stderr));
};
(async () => {
  console.log(clean((await import('./m.mjs?v=1')).f()));
  console.log(clean((await import('./m.mjs#h')).f()));
  console.log(clean((await import('./m.mjs')).f()));
  child('q-main.mjs');
  child('hashbang.js');
  child('hashbang-assert.js');
})();
