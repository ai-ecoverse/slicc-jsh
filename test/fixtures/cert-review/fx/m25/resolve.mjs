const show = (e) => `${e.code} | ${String(e.message).split('\n').join(' ')}${e.url ? ' | url=' + e.url.replace(/^file:\/\/.*\/m25\//, 'file:///M/') : ''}`;
const norm = (s) => s.replace(/\/[^ '"]*\/m25\//g, '/M/');
const tries = ['./lib/a.mjs', './lib/a', './lib/dir', './lib/dir/', './lib/dir/index.mjs', './lib/sp%20ace.mjs', './lib/sp ace.mjs', './lib/a.mjs?q=1', './lib/a.mjs#h', './lib/c.cjs', './lib/missing.mjs', 'pkgx', 'pkgx/sub', 'pkgx/sub/hidden.mjs', 'pkgx/nope', 'plain', 'plain/other', 'plain/other.js', 'nopkg', 'node:fs', 'fs', 'node:nope', 'data:text/javascript,export default 42', 'data:text/javascript;base64,ZXhwb3J0IGRlZmF1bHQgNDM=', 'https://example.com/x.mjs', 'ftp://x/y.mjs', 'file:///nonexistent/z.mjs', 'file://host/z.mjs', './lib%2Fa.mjs'];
for (const s of tries) { try { const m = await import(s); console.log('OK  ', s, JSON.stringify(Object.keys(m))); } catch (e) { console.log('ERR ', s, norm(show(e))); } }
for (const s of ['./lib/data.json', 'pkgx/json']) { try { await import(s); console.log('json no attr OK?', s); } catch (e) { console.log('json no attr', s, norm(show(e))); } try { const m = await import(s, { with: { type: 'json' } }); console.log('json with attr', s, JSON.stringify(m.default)); } catch (e) { console.log('json with attr ERR', s, norm(show(e))); } }
try { await import('./lib/a.mjs', { with: { type: 'json' } }); } catch (e) { console.log('wrong attr', norm(show(e))); }
try { await import('./lib/a.mjs', { with: { foo: 'bar' } }); } catch (e) { console.log('unsupported attr', norm(show(e))); }
try { await import('data:application/json,{"d":1}'); } catch (e) { console.log('data json no attr', norm(show(e))); }
console.log('data json attr', JSON.stringify((await import('data:application/json,{"d":1}', { with: { type: 'json' } })).default));
const i1 = await import('./lib/ident.mjs'), i2 = await import('./lib/ident.mjs?x'), i3 = await import('./lib/ident.mjs?x'), i4 = await import('./lib/ident.mjs#f');
console.log('identity', i1.n === i2.n, i2.n === i3.n, i1.n === i4.n);
for (const s of ['./lib/a.mjs', './lib/a', './lib/dir', 'pkgx', 'pkgx/sub', 'nopkg', './lib/a.mjs?q#h']) { try { console.log('meta.resolve', s, norm(import.meta.resolve(s))); } catch (e) { console.log('meta.resolve ERR', s, norm(show(e))); } }
console.log('meta.url', norm(import.meta.url), typeof import.meta.dirname, typeof import.meta.filename);
