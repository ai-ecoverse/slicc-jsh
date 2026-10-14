import { findSourceMap } from 'node:module';
const url = new URL('./out/tiny.mjs?v=1', import.meta.url).href;
const { where } = await import(url);
console.log(where().replace(new URL('.', import.meta.url).pathname.slice(0, -1), 'DIR'));
console.log(findSourceMap(url) !== undefined, findSourceMap(new URL('./out/tiny.mjs', import.meta.url).href));
