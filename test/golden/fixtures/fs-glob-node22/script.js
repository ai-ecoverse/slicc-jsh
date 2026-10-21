const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsglob-')));
process.chdir(work);
for (const d of ['src/lib/deep', 'src/empty', 'test', 'node_modules/pkg', '.hidden']) fs.mkdirSync(d, { recursive: true });
for (const f of ['src/a.js', 'src/b.mjs', 'src/lib/c.js', 'src/lib/deep/d.js', 'src/lib/deep/e.txt', 'test/a.test.js', 'node_modules/pkg/index.js', '.hidden/h.js', 'top.js', 'README.md', 'x[1].js']) fs.writeFileSync(f, f);
fs.symlinkSync('src/lib', 'link');
fs.symlinkSync('nowhere', 'dangling.js');
const err = (e) => `${e.name} ${e.code} ${JSON.stringify(e.message)}`;
const sort = (list) => [...list].map((x) => String(x).replace(work, '<work>')).sort();
const show = (label, list) => console.log(label, JSON.stringify(sort(list)));
const dirents = (list) => sort(list.map((d) => `${path.relative(work, d.parentPath) || '.'}|${d.name}|${d.isDirectory() ? 'd' : d.isSymbolicLink() ? 'l' : 'f'}|${d instanceof fs.Dirent}`));
const patterns = [
  '*.js',
  '**/*.js',
  'src/**',
  'src/**/',
  'src/*/',
  '**/*.{js,mjs}',
  'src/lib/../*.js',
  './src/*.js',
  'src/?.js',
  'src/[ab].*',
  '!(src)/*.js',
  '@(src|test)/*.js',
  '**/deep/*',
  '**',
  '*',
  'link/**',
  'link/*.js',
  'dangling.js',
  'missing/**',
  'x\\[1\\].js',
  'top.js/x',
  '',
  '.',
  '..',
  `${work}/src/*.js`,
];
(async () => {
  for (const p of patterns) {
    try {
      show(`globSync ${JSON.stringify(p.replace(work, '<work>'))}`, fs.globSync(p));
    } catch (e) {
      console.log(`globSync ${JSON.stringify(p.replace(work, '<work>'))}`, 'THROW', e.code, e.syscall);
    }
  }
  await Array.fromAsync(fs.promises.glob('top.js/x')).then((l) => show('promises.glob "top.js/x"', l), (e) => console.log('promises.glob "top.js/x"', 'THROW', e.code));
  show('globSync array', fs.globSync(['*.md', 'test/*']));
  show('globSync cwd', fs.globSync('**/*.js', { cwd: 'src' }));
  show('globSync cwd URL', fs.globSync('*.js', { cwd: pathToFileURL(path.join(work, 'src')) }));
  show('globSync cwd missing', fs.globSync('*', { cwd: 'missing' }));
  show('globSync exclude fn', fs.globSync('**/*.js', { exclude: (p) => p === 'node_modules' || p === 'test' }));
  show('globSync exclude array', fs.globSync('**/*.js', { exclude: ['node_modules/**', 'src/lib/**'] }));
  console.log('globSync withFileTypes', JSON.stringify(dirents(fs.globSync('src/**', { withFileTypes: true }))));
  console.log('globSync withFileTypes link', JSON.stringify(dirents(fs.globSync('link', { withFileTypes: true }))));
  console.log('globSync withFileTypes exclude', JSON.stringify(dirents(fs.globSync('src/*', { withFileTypes: true, exclude: (d) => d.isDirectory() }))));
  show('promises.glob', await Array.fromAsync(fs.promises.glob('**/*.js')));
  show('promises.glob cwd', await Array.fromAsync(fs.promises.glob('*/', { cwd: 'src' })));
  console.log('promises.glob withFileTypes', JSON.stringify(dirents(await Array.fromAsync(fs.promises.glob('src/lib/**', { withFileTypes: true })))));
  show('promises.glob exclude', await Array.fromAsync(fs.promises.glob('**/*.js', { exclude: ['**/deep/**', 'node_modules/**'] })));
  const it = fs.promises.glob('*.js');
  console.log('promises.glob iterator', typeof it.next, typeof it[Symbol.asyncIterator]);
  await new Promise((resolve) =>
    fs.glob('src/*.js', (e, list) => {
      console.log('glob(cb)', e, JSON.stringify(sort(list)));
      resolve();
    })
  );
  await new Promise((resolve) =>
    fs.glob('src/*', { withFileTypes: true }, (e, list) => {
      console.log('glob(cb) withFileTypes', e, JSON.stringify(dirents(list)));
      resolve();
    })
  );
  const bad = (label, f) => {
    try {
      const r = f();
      console.log(label, 'returned', typeof r);
    } catch (e) {
      console.log(label, 'THROW', err(e));
    }
  };
  bad('globSync number', () => fs.globSync(1));
  bad('globSync array of number', () => fs.globSync(['a', 1]));
  bad('globSync options string', () => fs.globSync('*', 'x'));
  bad('globSync cwd number', () => fs.globSync('*', { cwd: 1 }));
  bad('globSync exclude string', () => fs.globSync('*', { exclude: 'x' }));
  bad('globSync exclude [1]', () => fs.globSync('*', { exclude: [1] }));
  bad('glob no cb', () => fs.glob('*'));
  bad('glob bad cb', () => fs.glob('*', {}, 1));
  await new Promise((resolve) =>
    fs.glob(1, (e) => {
      console.log('glob(cb) number', err(e));
      resolve();
    })
  );
  bad('promises.glob number', () => fs.promises.glob(1));
  await Array.fromAsync(fs.promises.glob(1)).catch((e) => console.log('promises.glob number iterated', err(e)));
  fs.rmSync(work, { recursive: true });
})();
