// A data: URL module that imports a file: URL (eslint --concurrency builds
// its options so), and the specifiers a data: module can't resolve.
const path = require('path');
const { pathToFileURL } = require('url');
const lib = pathToFileURL(path.join(__dirname, 'lib.mjs')).href;
const data = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const t = async (label, source) => {
  try {
    const ns = await import(data(source));
    console.log(label, JSON.stringify(ns.default));
  } catch (e) {
    console.log(label, 'THROWS', e.code, e.message.split(' from "data:')[0].replace(__dirname, 'DIR'));
  }
};
(async () => {
  await t('file: URL', `import f, { name } from ${JSON.stringify(lib)}; export default [f(1), name];`);
  await t('file: URL with a query', `import f from ${JSON.stringify(lib + '?v=1')}; export default f(2);`);
  await t('dynamic file: URL', `export default (await import(${JSON.stringify(lib)})).name;`);
  await t('node: builtin', `import { sep } from 'node:path'; export default sep;`);
  await t('relative', `import f from './lib.mjs'; export default f(3);`);
  await t('absolute path', `import f from ${JSON.stringify(path.join(__dirname, 'lib.mjs'))}; export default f(4);`);
  const clean = (u) => u.split(pathToFileURL(__dirname).href).join('DIR');
  const resolved = await import(
    data(`export default [${JSON.stringify(lib + '?v=1#h')}, ${JSON.stringify(lib.replace('lib.mjs', 'nope.mjs?q'))}, 'node:fs', 'fs'].map((s) => import.meta.resolve(s));`)
  );
  console.log('import.meta.resolve', JSON.stringify(resolved.default.map(clean)));
})();
