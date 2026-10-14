// Source maps (--enable-source-maps, process.setSourceMapsEnabled, the module
// API) over esbuild bundles of src/*.ts: inline with sourcesContent, a .map
// file without (the sources are read from disk), an ES module. Each run is a
// child, its paths shown relative to this directory. Node's own frames
// (node:internal/…) are left out: jsh has none.
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const show = (label, args, options = {}) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', ...options });
  const clean = (text) =>
    text
      .split(pathToFileURL(__dirname).href)
      .join('file://DIR')
      .split(__dirname)
      .join('DIR')
      .split('\n')
      .filter((l) => !/\(node:|at node:/.test(l))
      .join('\n');
  console.log(`== ${label}: status ${r.status}`);
  process.stdout.write(clean(r.stdout));
  process.stdout.write(clean(r.stderr));
};
show('inline map, sourcesContent', ['--enable-source-maps', 'out/inline.js']);
show('map file, sources from disk', ['--enable-source-maps', 'out/file.js']);
show('ES module', ['--enable-source-maps', 'out/esm.mjs']);
show('original sources missing', ['--enable-source-maps', 'out/nosrc.js']);
show('a CommonJS bundle with a hashbang', ['--enable-source-maps', 'out/hashbang.js']);
show('an ES module imported with a query', ['--enable-source-maps', 'esm-query.mjs']);
show('no source maps', ['out/file.js']);
show('process.setSourceMapsEnabled(true) before the require', [
  '-e',
  "console.log(process.sourceMapsEnabled); process.setSourceMapsEnabled(true); console.log(process.sourceMapsEnabled, JSON.stringify(require('module').getSourceMapsSupport())); require('./out/inline.js')",
]);
show('module API', [
  '--enable-source-maps',
  '-e',
  [
    "const m = require('module');",
    "console.log(JSON.stringify(m.getSourceMapsSupport()), typeof m.SourceMap, m.findSourceMap(require.resolve('./out/file.js')));",
    "try { require('./out/file.js') } catch {}",
    "const sm = m.findSourceMap(require.resolve('./out/file.js'));",
    "console.log(sm instanceof m.SourceMap, JSON.stringify(sm.payload.sources), JSON.stringify(sm.payload.sourceRoot), sm.lineLengths.length);",
    'console.log(sm.findEntry(3, 10));',
    'console.log(sm.findOrigin(4, 11));',
    'console.log(sm.findEntry(1000, 0));',
    "console.log(m.findSourceMap(require('url').pathToFileURL(require.resolve('./out/file.js')).href) === sm, m.findSourceMap('node:fs'), m.findSourceMap(1));",
    "const own = new m.SourceMap({ version: 3, sources: ['a.js'], names: ['x'], mappings: 'AAAAA' });",
    'console.log(own.findEntry(0, 0), own.payload.names);',
    "try { new m.SourceMap(1) } catch (e) { console.log(e.code) }",
  ].join('\n'),
]);
