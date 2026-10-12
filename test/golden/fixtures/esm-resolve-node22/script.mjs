// Node 22's ESM resolver: exact files, URL specifiers, its errors and hints.
const base = new URL('./', import.meta.url).href;
const dir = new URL('./', import.meta.url).pathname.replace(/\/$/, '');
const clean = (t) => String(t).split(base).join('BASE/').split(dir).join('DIR');
const show = async (s) => {
  try {
    const m = await import(s);
    console.log(s, 'OK', m.default);
  } catch (e) {
    console.log(s, '|', e.code, '|', clean(e.message), '|', JSON.stringify(Object.keys(e)), e.url === undefined ? '' : clean(e.url));
  }
};
for (const s of [
  './nope.mjs', './ext', './ext.mjs', './ext.mjs?q=1', './a%20b.mjs', './dd', './dd/',
  'nopkg', '@sc/nopkg/sub', 'realpkg', 'realpkg/sub', 'realpkg/sub.js', '@sc/x', '@sc/x/i',
  'expkg', 'expkg/missing', 'expkg/x/a.mjs', 'expkg/nothere', '/abs/nope.mjs', 'file:///abs/nope.mjs',
  'sliccy:exec', 'foo:bar', 'https://x.example/a.js',
  'data:text/javascript,export default 7', 'data:text/javascript;base64,ZXhwb3J0IGRlZmF1bHQgOA==',
]) await show(s);
for (const s of ['./ext.mjs?q#h', './dd', './missing.js', 'data:text/javascript,1', 'expkg']) console.log('resolve', s, clean(import.meta.resolve(s)));
try { import.meta.resolve('nopkg'); } catch (e) { console.log('resolve nopkg', e.code, clean(e.message)); }
