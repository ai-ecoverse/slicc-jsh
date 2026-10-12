// Node 22's import attributes, module identity by full URL (query and
// fragment), file: URL hosts, encoded slashes, and data: modules as bases.
import data from './j.json' with { type: 'json' };
const dir = new URL('./', import.meta.url).pathname.replace(/\/$/, '');
const clean = (t) => String(t).split(new URL('./', import.meta.url).href).join('BASE/').split(dir).join('DIR');
const show = async (label, p) => {
  try {
    const m = await p;
    console.log(label, 'OK', JSON.stringify(m.default), JSON.stringify(Object.keys(m)));
  } catch (e) {
    console.log(label, e.name, e.code, clean(e.message));
  }
};
console.log('static json', JSON.stringify(data));
await show('json no attr', import('./j.json'));
await show('json attr', import('./j.json', { with: { type: 'json' } }));
await show('json bad type', import('./j.json', { with: { type: 'css' } }));
await show('js with json', import('./jsm.mjs', { with: { type: 'json' } }));
await show('other key', import('./j.json', { with: { type: 'json', foo: 'x' } }));
await show('data json', import('data:application/json,{"b":2}'));
await show('data json attr', import('data:application/json,{"b":2}', { with: { type: 'json' } }));
await show('data rel', import('data:text/javascript,import "./x.mjs"'));
await show('file host', import('file://evil/x.mjs').catch((e) => { throw Object.assign(new TypeError(e.message.replace(/ on [a-z]+$/, ' on PLATFORM')), { code: e.code }); }));
await show('file localhost', import(`file://localhost${dir}/jsm.mjs`));
await show('enc slash', import('./a%2Fb.mjs'));
await show('opts not object', import('./jsm.mjs', 5));
await show('with not object', import('./jsm.mjs', { with: 5 }));
await show('query a', import('./jsm.mjs?a=1#f'));
const a = await import('./counter.mjs?a');
const b = await import('./counter.mjs?b');
a.bump();
console.log('distinct by query', a !== b, a.n, b.n, (await import('./counter.mjs?a')) === a);
console.log('meta.resolve', clean(import.meta.resolve('./jsm.mjs?q#h')));
